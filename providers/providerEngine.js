/**
 * providers/providerEngine.js — Universal Multi-Provider Fetch Engine
 *
 * Supports ALL asset classes:
 *   US stocks/ETFs, Indian NSE/BSE, Indian indices, US/Global indices,
 *   Crypto, Forex, UK, Japan, Germany, HK, Canada, Australia + more
 *
 * Routing strategy — each symbol pattern maps to an optimized provider list.
 * Yahoo is always the final fallback since it covers every asset class.
 *
 * Features:
 *  1. Pattern-based smart routing  — correct providers for every asset type
 *  2. Health-based sorting         — fastest + healthiest provider goes first
 *  3. Automatic fallback           — next provider tried on any failure
 *  4. Parallel racing              — slow primary races against backup
 *  5. Rate limit detection         — provider skipped during cooldown
 *  6. Consistent response shape    — normalizeResponse() on every result
 */

import * as health     from "./providerHealth.js";
import * as finnhub    from "./finnhub.js";
import * as twelvedata from "./twelvedata.js";
import * as alphav     from "./alphavantage.js";
import * as yahoo      from "./yahoo.js";
import * as nseIndia   from "./nseIndia.js";
import { normalizeSymbol } from "../utils/symbolNormalizer.js";

const ALL_PROVIDERS = [finnhub, twelvedata, alphav, yahoo, nseIndia];

const PROVIDER_MAP = Object.fromEntries(
  ALL_PROVIDERS.map(p => [p.NAME, p])
);

/* ── Parallel racing threshold ── */
const RACE_THRESHOLD_MS = 4000;

/* ════════════════════════════════════════════════════════════
   SMART SYMBOL ROUTER
   Returns the best provider priority list for any symbol.
   Patterns are tested in order — first match wins.
════════════════════════════════════════════════════════════ */

const ROUTES = [
  // ── Indian synthetic index symbols (post-normalization) ─────────────────
  // These MUST go to Yahoo — NseIndia and others don't handle them
  {
    test:     (s) => /^(NIFTY50|BANKNIFTY|SENSEX)\.NS$/i.test(s),
    type:     "INDIAN_INDEX",
    priority: ["Yahoo"],
  },

  // ── Indian NSE stocks ────────────────────────────────────────────────────
  {
    test:     (s) => /\.(NS|NSE)$/i.test(s),
    type:     "INDIAN_NSE",
    priority: ["NseIndia", "TwelveData", "Yahoo"],
  },

  // ── Indian BSE stocks ────────────────────────────────────────────────────
  {
    test:     (s) => /\.(BO|BSE)$/i.test(s),
    type:     "INDIAN_BSE",
    priority: ["NseIndia", "Yahoo"],
  },

  // ── Global indices (^ prefix — Yahoo natively handles all of them) ───────
  {
    test:     (s) => s.startsWith("^"),
    type:     "INDEX",
    priority: ["Yahoo"],
  },

  // ── Crypto (BTC-USD, ETH-INR, SOL-USDT …) ───────────────────────────────
  {
    test:     (s) => /^[A-Z0-9]{2,10}-(USD|INR|EUR|GBP|BTC|ETH|USDT)$/i.test(s),
    type:     "CRYPTO",
    priority: ["TwelveData", "Yahoo"],
  },

  // ── Forex (EURUSD=X, GBPINR=X …) ────────────────────────────────────────
  {
    test:     (s) => /=X$/i.test(s),
    type:     "FOREX",
    priority: ["TwelveData", "Finnhub", "Yahoo"],
  },

  // ── UK stocks (.L suffix) ────────────────────────────────────────────────
  {
    test:     (s) => /\.(L|LON)$/i.test(s),
    type:     "UK",
    priority: ["TwelveData", "Yahoo"],
  },

  // ── Japan stocks (.T suffix) ─────────────────────────────────────────────
  {
    test:     (s) => /\.T$/i.test(s),
    type:     "JAPAN",
    priority: ["TwelveData", "Yahoo"],
  },

  // ── German/EU stocks (.DE, .F, .XETRA) ──────────────────────────────────
  {
    test:     (s) => /\.(DE|F|XETRA)$/i.test(s),
    type:     "GERMANY",
    priority: ["TwelveData", "Yahoo"],
  },

  // ── Hong Kong stocks (.HK) ───────────────────────────────────────────────
  {
    test:     (s) => /\.HK$/i.test(s),
    type:     "HONGKONG",
    priority: ["TwelveData", "Yahoo"],
  },

  // ── Canadian stocks (.TO, .TSX) ─────────────────────────────────────────
  {
    test:     (s) => /\.(TO|TSX)$/i.test(s),
    type:     "CANADA",
    priority: ["TwelveData", "Yahoo"],
  },

  // ── Australian stocks (.AX) ──────────────────────────────────────────────
  {
    test:     (s) => /\.AX$/i.test(s),
    type:     "AUSTRALIA",
    priority: ["TwelveData", "Yahoo"],
  },

  // ── French stocks (.PA) ──────────────────────────────────────────────────
  {
    test:     (s) => /\.PA$/i.test(s),
    type:     "FRANCE",
    priority: ["TwelveData", "Yahoo"],
  },

  // ── Italian stocks (.MI) ─────────────────────────────────────────────────
  {
    test:     (s) => /\.MI$/i.test(s),
    type:     "ITALY",
    priority: ["TwelveData", "Yahoo"],
  },

  // ── Swiss stocks (.SW) ───────────────────────────────────────────────────
  {
    test:     (s) => /\.SW$/i.test(s),
    type:     "SWITZERLAND",
    priority: ["TwelveData", "Yahoo"],
  },

  // ── US stocks / ETFs (plain symbols, no suffix) ──────────────────────────
  // Also catches OTC symbols — Finnhub may fail but TwelveData + Yahoo cover them
  {
    test:     (s) => /^[A-Z0-9.\-]{1,10}$/i.test(s),
    type:     "US_STOCK",
    priority: ["Finnhub", "TwelveData", "AlphaVantage", "Yahoo"],
  },

  // ── Catch-all ────────────────────────────────────────────────────────────
  {
    test:     () => true,
    type:     "UNKNOWN",
    priority: ["Yahoo"],
  },
];

/**
 * getProviderPriority(symbol)
 * Returns the priority list for a symbol, filtered to healthy + supporting providers.
 * Always guarantees Yahoo as a last resort even if all others are in cooldown.
 */
const getProviderPriority = (symbol) => {
  const route   = ROUTES.find(r => r.test(symbol)) || ROUTES[ROUTES.length - 1];
  const healthy = health.sortByHealth(route.priority).filter(name => {
    const p = PROVIDER_MAP[name];
    return p && p.supports(symbol);
  });

  console.log(`[Engine] Route: ${symbol} → ${route.type} → ${healthy.join(" → ") || "Yahoo (forced)"}`);

  // Always have at least Yahoo as a fallback
  if (!healthy.length) {
    console.warn(`[Engine] ⚠️  All providers in cooldown for ${symbol} — forcing Yahoo`);
    return ["Yahoo"];
  }

  // Guarantee Yahoo appears in list if not already present
  if (!healthy.includes("Yahoo") && PROVIDER_MAP["Yahoo"]?.supports(symbol)) {
    healthy.push("Yahoo");
  }

  return healthy;
};

/* ════════════════════════════════════════════════════════════
   CORE: try one provider, record health metrics
════════════════════════════════════════════════════════════ */
const tryProvider = async (providerName, symbol, range) => {
  const provider = PROVIDER_MAP[providerName];
  if (!provider)              throw new Error(`Unknown provider: ${providerName}`);
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
    console.log(`[Engine] ✅ ${providerName} — ${symbol} in ${ms}ms`);
    return data;

  } catch (err) {
    health.recordFailure(providerName, err);

    const isRateLimit = err?.response?.status === 429
      || /rate.?limit|quota|too many|429/i.test(err.message);

    console.warn(
      isRateLimit
        ? `[Engine] ⏸  Rate limited: ${providerName}`
        : `[Engine] ❌ Failed: ${providerName} — ${err.message}`
    );
    throw err;
  }
};

/* ════════════════════════════════════════════════════════════
   PARALLEL RACE between two providers
════════════════════════════════════════════════════════════ */
const raceProviders = (p1, p2, symbol, range) =>
  new Promise((resolve, reject) => {
    let settled = false;
    const errors = [];

    const attempt = (name) => {
      tryProvider(name, symbol, range)
        .then(data => {
          if (!settled) {
            settled = true;
            console.log(`[Engine] 🏁 Race won: ${name}`);
            resolve({ data, provider: name });
          }
        })
        .catch(err => {
          errors.push(`${name}: ${err.message}`);
          if (errors.length === 2 && !settled) {
            settled = true;
            reject(new Error(`Both failed: ${errors.join(" | ")}`));
          }
        });
    };

    attempt(p1);
    attempt(p2);
  });

/* ════════════════════════════════════════════════════════════
   MAIN: fetchStock(symbol, range)
   Symbol must already be normalized (call normalizeSymbol first).
════════════════════════════════════════════════════════════ */
export const fetchStock = async (symbol, range) => {
  const ordered = getProviderPriority(symbol);

  for (let i = 0; i < ordered.length; i++) {
    const primary = ordered[i];
    const backup  = ordered[i + 1];

    try {
      if (backup && health.isAvailable(backup)) {
        let primaryDone   = false;
        let primaryResult = null;

        const primaryPromise = tryProvider(primary, symbol, range).then(d => {
          primaryDone   = true;
          primaryResult = d;
          return d;
        });

        primaryPromise.catch(() => {}); // prevent unhandled rejection

        await new Promise(r => setTimeout(r, RACE_THRESHOLD_MS));

        if (primaryDone) return normalizeResponse(primaryResult, symbol, range);

        // Primary slow — race with backup
        console.log(`[Engine] 🏎  ${primary} slow — racing with ${backup}`);
        try {
          const { data } = await raceProviders(primary, backup, symbol, range);
          return normalizeResponse(data, symbol, range);
        } catch {
          try {
            const data = await primaryPromise;
            return normalizeResponse(data, symbol, range);
          } catch {
            continue;
          }
        }
      } else {
        const data = await tryProvider(primary, symbol, range);
        return normalizeResponse(data, symbol, range);
      }
    } catch {
      if (i < ordered.length - 1) {
        console.log(`[Engine] Trying next: ${ordered[i + 1]}`);
      } else {
        throw new Error(
          `All providers failed for ${symbol}. Check API keys and connectivity.`
        );
      }
    }
  }

  throw new Error(`No data returned for ${symbol} from any provider.`);
};

/* ════════════════════════════════════════════════════════════
   normalizeResponse — consistent shape from any provider
════════════════════════════════════════════════════════════ */
const normalizeResponse = (data, symbol, range) => {
  const last = data.candles?.[data.candles.length - 1];
  const isIndian = /\.(NS|BO|NSE|BSE)$/i.test(symbol);

  return {
    symbol:        data.symbol        || symbol,
    name:          data.name          || symbol,
    price:         data.price         ?? last?.close ?? 0,
    open:          data.open          ?? last?.open  ?? undefined,
    high:          data.high          ?? last?.high  ?? undefined,
    low:           data.low           ?? last?.low   ?? undefined,
    prevClose:     data.prevClose     ?? undefined,
    changePercent: String(data.changePercent ?? 0),
    currency:      data.currency      || (isIndian ? "INR" : "USD"),
    exchange:      data.exchange      || (isIndian ? "NSE" : "NASDAQ"),
    candles:       data.candles       || [],
    provider:      data.provider      || "unknown",
    range,
    fetchedAt:     new Date().toISOString(),
  };
};

/* ════════════════════════════════════════════════════════════
   getLiveStockData — live price for WebSocket / quick API
   Accepts raw symbol (^NSEI) or normalized (NIFTY50.NS).
════════════════════════════════════════════════════════════ */
export const getLiveStockData = async (rawSymbol) => {
  const symbol = normalizeSymbol(String(rawSymbol).toUpperCase().trim());

  const isIndian = /\.(NS|BO|NSE|BSE)$/i.test(symbol);

  if (isIndian) {
    // Synthetic index symbols — NseIndia can't handle these, use Yahoo
    const isSyntheticIndex = /^(NIFTY50|BANKNIFTY|SENSEX)\.NS$/i.test(symbol);

    if (!isSyntheticIndex && health.isAvailable("NseIndia")) {
      try {
        return await nseIndia.getLiveQuote(symbol);
      } catch (e) {
        console.warn(`[Engine] NseIndia live failed: ${e.message} — falling back`);
      }
    }

    // Yahoo fallback for Indian (including synthetic indices)
    const ySym = /\.(NS|BO)$/i.test(symbol) ? symbol : symbol + ".NS";
    const data = await yahoo.fetch(ySym, "1W");
    const last = data.candles[data.candles.length - 1];
    return {
      symbol,
      price:         data.price,
      changePercent: data.changePercent,
      open:          data.open,
      high:          data.high,
      low:           data.low,
      prevClose:     data.prevClose,
      currency:      data.currency || "INR",
      tick: {
        time:   new Date().toISOString(),
        close:  data.price,
        open:   data.open,
        high:   data.high,
        low:    data.low,
        volume: last?.volume || 0,
      },
    };
  }

  // Global indices — Yahoo only
  if (symbol.startsWith("^")) {
    const data = await yahoo.fetch(symbol, "1W");
    const last = data.candles[data.candles.length - 1];
    return {
      symbol,
      price:         data.price,
      changePercent: data.changePercent,
      open:          data.open,
      high:          data.high,
      low:           data.low,
      prevClose:     data.prevClose,
      currency:      data.currency || "USD",
      tick: {
        time:   new Date().toISOString(),
        close:  data.price,
        open:   data.open,
        high:   data.high,
        low:    data.low,
        volume: last?.volume || 0,
      },
    };
  }

  // US stocks — Finnhub best for live quotes
  if (health.isAvailable("Finnhub")) {
    try {
      const { default: axios } = await import("axios");
      const key = process.env.FINNHUB_KEY || process.env.FINNHUB_API_KEY;
      const { data } = await axios.get("https://finnhub.io/api/v1/quote", {
        params: { symbol, token: key }, timeout: 8000,
      });
      if (data?.c > 0) {
        health.recordSuccess("Finnhub", 0);
        return {
          symbol,
          price:         +data.c.toFixed(2),
          changePercent: (((data.c - data.pc) / data.pc) * 100).toFixed(2),
          open:          data.o,
          high:          data.h,
          low:           data.l,
          prevClose:     data.pc,
          currency:      "USD",
          tick: {
            time:   new Date().toISOString(),
            close:  data.c,
            open:   data.o,
            high:   data.h,
            low:    data.l,
            volume: data.v || 0,
          },
        };
      }
    } catch (e) {
      health.recordFailure("Finnhub", e);
    }
  }

  // Final fallback — Yahoo for everything else (crypto, forex, intl stocks)
  const data = await yahoo.fetch(symbol, "1W");
  const last = data.candles[data.candles.length - 1];
  return {
    symbol,
    price:         data.price,
    changePercent: data.changePercent,
    open:          data.open,
    high:          data.high,
    low:           data.low,
    prevClose:     data.prevClose,
    currency:      data.currency || "USD",
    tick: {
      time:   new Date().toISOString(),
      close:  data.price,
      open:   data.open,
      high:   data.high,
      low:    data.low,
      volume: last?.volume || 0,
    },
  };
};

/* ── Export health stats for monitoring ── */
export const getHealthStats = health.getStats;
export const resetProvider  = health.resetProvider;