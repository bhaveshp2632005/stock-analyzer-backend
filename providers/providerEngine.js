/**
 * providerEngine.js — Smart Multi-Provider Fetch Engine
 *
 * Features:
 *  1. Health-based provider sorting   — fastest + healthiest goes first
 *  2. Automatic fallback              — if provider fails, try next immediately
 *  3. Parallel racing                 — if first provider is slow, start second in parallel
 *  4. Rate limit detection            — marks provider, skips during cooldown
 *  5. Response normalization          — all providers return same shape
 *  6. Clear logging                   — success / fail / fallback / rate-limit per fetch
 *
 * Usage:
 *   import { fetchStock } from "./providerEngine.js";
 *   const data = await fetchStock("AAPL", "1M");      // US
 *   const data = await fetchStock("RELIANCE.NS","1M"); // Indian
 */

import * as health    from "./providerHealth.js";
import * as finnhub   from "./finnhub.js";
import * as twelvedata from "./twelvedata.js";
import * as alphav    from "./alphavantage.js";
import * as yahoo     from "./yahoo.js";
import * as nseIndia  from "./nseIndia.js";

/* ── Provider registry ── */
const ALL_PROVIDERS = [finnhub, twelvedata, alphav, yahoo, nseIndia];

/* Provider priority order per market
   - Indian: NseIndia first (most accurate), then universal providers
   - US:     Finnhub first (live quote), then universal providers       */
const US_PRIORITY     = ["Finnhub", "TwelveData", "AlphaVantage", "Yahoo"];
const INDIAN_PRIORITY = ["NseIndia", "TwelveData", "AlphaVantage", "Yahoo"];

const isIndian = (s) => /\.(NS|BO|NSE|BSE)$/i.test(s);

/* Map name → provider module */
const PROVIDER_MAP = Object.fromEntries(
  ALL_PROVIDERS.map(p => [p.NAME, p])
);

/* ── Parallel racing config ──
   If primary provider hasn't returned after RACE_THRESHOLD_MS,
   launch the next-best provider in parallel.
   Whichever resolves first wins. */
const RACE_THRESHOLD_MS = 4000;

/* ════════════════════════════════════════════════════════════
   CORE: try one provider, record health, throw on failure
════════════════════════════════════════════════════════════ */
const tryProvider = async (providerName, symbol, range) => {
  const provider = PROVIDER_MAP[providerName];
  if (!provider) throw new Error(`Unknown provider: ${providerName}`);
  if (!provider.supports(symbol)) throw new Error(`${providerName} does not support ${symbol}`);
  if (!health.isAvailable(providerName)) throw new Error(`${providerName} unavailable (cooldown)`);

  const start = Date.now();
  try {
    const data = await provider.fetch(symbol, range);
    const ms   = Date.now() - start;

    if (!data || !data.price || !data.candles?.length) {
      throw new Error(`${providerName}: returned empty/invalid data`);
    }

    health.recordSuccess(providerName, ms);
    console.log(`[Engine] ✅ Provider success: ${providerName} — ${symbol} in ${ms}ms`);
    return data;

  } catch (err) {
    health.recordFailure(providerName, err);

    const isRateLimit = err?.response?.status === 429
      || /rate.?limit|quota|too many|429/i.test(err.message);

    if (isRateLimit) {
      console.warn(`[Engine] ⏸  Provider rate limited: ${providerName}`);
    } else {
      console.warn(`[Engine] ❌ Provider failed: ${providerName} — ${err.message}`);
    }
    throw err;
  }
};

/* ════════════════════════════════════════════════════════════
   PARALLEL RACE between two providers
   Returns whichever resolves first with valid data.
════════════════════════════════════════════════════════════ */
const raceProviders = (p1name, p2name, symbol, range) =>
  new Promise((resolve, reject) => {
    let settled = false;
    const errors = [];

    const attempt = (name) => {
      tryProvider(name, symbol, range)
        .then(data => {
          if (!settled) {
            settled = true;
            console.log(`[Engine] 🏁 Race won by: ${name}`);
            resolve({ data, provider: name });
          }
        })
        .catch(err => {
          errors.push(`${name}: ${err.message}`);
          if (errors.length === 2 && !settled) {
            settled = true;
            reject(new Error(`Both providers failed: ${errors.join(" | ")}`));
          }
        });
    };

    attempt(p1name);
    attempt(p2name);
  });

/* ════════════════════════════════════════════════════════════
   MAIN: fetchStock(symbol, range)
   Tries providers in health-sorted priority order.
   Activates parallel racing if primary is slow.
════════════════════════════════════════════════════════════ */
export const fetchStock = async (symbol, range) => {
  const priority = isIndian(symbol) ? INDIAN_PRIORITY : US_PRIORITY;

  // Get available providers sorted by health score (best first)
  const ordered = health.sortByHealth(priority).filter(name => {
    const p = PROVIDER_MAP[name];
    return p && p.supports(symbol);
  });

  if (!ordered.length) {
    // All providers in cooldown — force try Yahoo as last resort
    console.warn(`[Engine] ⚠️  All providers in cooldown for ${symbol} — forcing Yahoo`);
    return tryProvider("Yahoo", symbol, range);
  }

  console.log(`[Engine] Provider order for ${symbol}: ${ordered.join(" → ")}`);

  // Try each provider with parallel racing on slow response
  for (let i = 0; i < ordered.length; i++) {
    const primary = ordered[i];
    const backup  = ordered[i + 1]; // may be undefined

    try {
      if (backup && health.isAvailable(backup)) {
        // Start primary. If it takes too long, race with backup.
        let primaryResult = null;
        let primaryDone   = false;

        const primaryPromise = tryProvider(primary, symbol, range).then(d => {
          primaryDone = true;
          primaryResult = d;
          return d;
        });

        // Attach .catch immediately — prevents Node.js unhandled rejection crash
        // The actual error is handled in the catch block below
        primaryPromise.catch(() => {});

        // Wait RACE_THRESHOLD_MS; if primary not done, start racing
        await new Promise(r => setTimeout(r, RACE_THRESHOLD_MS));

        if (primaryDone) {
          return normalizeResponse(primaryResult, symbol, range);
        }

        // Primary is slow — race it with backup
        console.log(`[Engine] 🏎  Primary ${primary} slow — racing with ${backup}`);
        try {
          const { data } = await raceProviders(primary, backup, symbol, range);
          return normalizeResponse(data, symbol, range);
        } catch (_raceErr) {
          // Both in race failed — wait for original primary or move on
          try {
            const data = await primaryPromise;
            return normalizeResponse(data, symbol, range);
          } catch {
            console.warn(`[Engine] Fallback used: moving to next provider after ${primary}`);
            continue;
          }
        }
      } else {
        // No backup available — try primary directly
        const data = await tryProvider(primary, symbol, range);
        return normalizeResponse(data, symbol, range);
      }

    } catch (err) {
      if (i < ordered.length - 1) {
        console.log(`[Engine] Fallback used: ${ordered[i + 1]} after ${primary} failed`);
      } else {
        throw new Error(
          `All providers failed for ${symbol}. Last error: ${err.message}. ` +
          `Check API keys and network connectivity.`
        );
      }
    }
  }

  throw new Error(`No data returned for ${symbol} from any provider.`);
};

/* ════════════════════════════════════════════════════════════
   normalizeResponse — ensure consistent shape regardless of provider
════════════════════════════════════════════════════════════ */
const normalizeResponse = (data, symbol, range) => {
  const last = data.candles?.[data.candles.length - 1];

  // Ensure all required fields exist
  return {
    symbol:        data.symbol        || symbol,
    name:          data.name          || symbol,
    price:         data.price         ?? last?.close ?? 0,
    open:          data.open          ?? last?.open  ?? undefined,
    high:          data.high          ?? last?.high  ?? undefined,
    low:           data.low           ?? last?.low   ?? undefined,
    prevClose:     data.prevClose     ?? undefined,
    changePercent: String(data.changePercent ?? 0),
    currency:      data.currency      || (isIndian(symbol) ? "INR" : "USD"),
    exchange:      data.exchange      || (isIndian(symbol) ? "NSE" : "NASDAQ"),
    candles:       data.candles       || [],
    provider:      data.provider      || "unknown",
    range,
    fetchedAt:     new Date().toISOString(),
  };
};

/* ════════════════════════════════════════════════════════════
   getLiveStockData — lightweight live price for WebSocket
   Uses fastest available provider for a quick quote
════════════════════════════════════════════════════════════ */
export const getLiveStockData = async (symbol) => {
  symbol = symbol.toUpperCase();

  if (isIndian(symbol)) {
    // NseIndia is best for live Indian quotes
    if (health.isAvailable("NseIndia")) {
      try {
        return await nseIndia.getLiveQuote(symbol);
      } catch (e) {
        console.warn(`[Engine] NseIndia live failed: ${e.message}, falling back to Yahoo`);
      }
    }
    // Fallback to Yahoo for live Indian
    const ySym = /\.(NS|BO)$/i.test(symbol) ? symbol : symbol + ".NS";
    const data = await yahoo.fetch(ySym, "1W");
    const last = data.candles[data.candles.length - 1];
    return {
      symbol, price: data.price, changePercent: data.changePercent,
      open: data.open, high: data.high, low: data.low, prevClose: data.prevClose,
      tick: { time: new Date().toISOString(), close: data.price, open: data.open, high: data.high, low: data.low, volume: last?.volume || 0 },
    };
  }

  // US: Finnhub is best for live quotes
  if (health.isAvailable("Finnhub")) {
    try {
      const { default: axios } = await import("axios");
      const key = process.env.FINNHUB_KEY || process.env.FINNHUB_API_KEY;
      const { data } = await axios.get("https://finnhub.io/api/v1/quote", { params: { symbol, token: key }, timeout: 8000 });
      if (data?.c > 0) {
        health.recordSuccess("Finnhub", 0);
        return {
          symbol, price: +data.c.toFixed(2),
          changePercent: (((data.c - data.pc) / data.pc) * 100).toFixed(2),
          open: data.o, high: data.h, low: data.l, prevClose: data.pc,
          tick: { time: new Date().toISOString(), close: data.c, open: data.o, high: data.h, low: data.l, volume: data.v || 0 },
        };
      }
    } catch (e) {
      health.recordFailure("Finnhub", e);
    }
  }

  // Fallback: Yahoo live
  const data = await yahoo.fetch(symbol, "1W");
  return {
    symbol, price: data.price, changePercent: data.changePercent,
    open: data.open, high: data.high, low: data.low, prevClose: data.prevClose,
    tick: { time: new Date().toISOString(), close: data.price, open: data.open, high: data.high, low: data.low, volume: 0 },
  };
};

/* ── Export health stats for monitoring ── */
export const getHealthStats  = health.getStats;
export const resetProvider   = health.resetProvider;