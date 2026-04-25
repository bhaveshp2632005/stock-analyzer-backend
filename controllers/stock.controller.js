/**
 * stock.controller.js — Refactored with Multi-Provider Engine
 * + Full Index Symbol Support (^NSEI, ^BSESN, ^NSEBANK)
 *
 * Controller flow:
 *  1. Cache check (stockCache.js)
 *  2. Normalize index symbols via normalizeSymbol()
 *  3. Call providerEngine.fetchStock() — handles all provider logic
 *  4. Attach RSI / MACD / EMA / signal indicators
 *  5. Cache the result
 *  6. Return to client with originalSymbol + type tag
 *
 * API endpoints unchanged:
 *  GET  /api/stock/:symbol?range=1M
 *  POST /api/stock/batch
 *  GET  /api/stock/:symbol/quick
 *  GET  /api/stock/health
 */

import { calculateRSI, calculateMACD, emaSeries } from "../utils/indicators.js";
import { fetchStock, getLiveStockData, getHealthStats } from "../providers/providerEngine.js";
import {
  serverCacheGet,
  serverCacheSet,
  serverCacheKey,
  serverCacheTTL,
} from "./stockCache.js";
import {
  normalizeSymbol,
  getSymbolType,
  getDisplayName,
} from "../utils/symbolNormalizer.js";

/* ── Valid ranges ── */
const VALID_RANGES = new Set(["1W", "1M", "3M", "6M", "1Y", "5Y"]);

/* ── EMA period ── */
const EMA_PERIOD = 20;

/* ── Indicator series helpers ── */
const rsiSeries = (closes) =>
  closes.map((_, i) => (i < 14 ? null : calculateRSI(closes.slice(i - 14, i + 1))));

const macdSeries = (closes) =>
  closes.map((_, i) => (i < 26 ? null : calculateMACD(closes.slice(0, i + 1))));

const getSignal = (rsi, macd) => {
  if (rsi == null || macd == null) return "HOLD";
  if (rsi < 35 && macd > 0) return "BUY";
  if (rsi > 65 && macd < 0) return "SELL";
  return "HOLD";
};

const rowSig = (rsi, macd) => {
  const s = getSignal(rsi, macd);
  return s === "HOLD" ? null : s;
};

/* ════════════════════════════════════════════════════════════
   attachIndicators
   Attaches RSI / MACD / EMA / signal to the engine result.
   Also stamps originalSymbol, type, and human name on the response.
════════════════════════════════════════════════════════════ */
const attachIndicators = (data, range, originalSymbol) => {
  const closes     = data.candles.map((c) => c.close);
  const rsi        = rsiSeries(closes);
  const macd       = macdSeries(closes);
  const ema        = emaSeries(closes, EMA_PERIOD);
  const latestRSI  = rsi[rsi.length - 1];
  const latestMACD = macd[macd.length - 1];
  const latestEMA  = ema[ema.length - 1];
  const sig        = getSignal(latestRSI, latestMACD);

  // Use a human display name for known indices, otherwise fall back to provider name
  const displayName = getDisplayName(originalSymbol);
  const name = displayName !== originalSymbol
    ? displayName
    : (data.name || originalSymbol);

  return {
    /* ── Identity ── */
    symbol:       originalSymbol,           // always what the client sent (^NSEI, AAPL …)
    normalizedAs: data.symbol,              // what was actually fetched (NIFTY50.NS, AAPL …)
    type:         getSymbolType(originalSymbol), // "INDEX" | "STOCK"

    /* ── Price ── */
    name,
    price:         data.price,
    open:          data.open,
    high:          data.high,
    low:           data.low,
    prevClose:     data.prevClose,
    changePercent: data.changePercent,
    currency:      data.currency,
    exchange:      data.exchange,

    /* ── Summary indicators ── */
    indicators: {
      rsi:    latestRSI,
      macd:   latestMACD,
      ema:    latestEMA,
      signal: sig,
    },

    /* ── Per-candle chart data ── */
    chart: data.candles.map((c, i) => ({
      ...c,
      rsi:    rsi[i],
      macd:   macd[i],
      ema:    ema[i],
      signal: rowSig(rsi[i], macd[i]),
    })),

    range,
    provider:  data.provider,
    fetchedAt: data.fetchedAt,
  };
};

/* ════════════════════════════════════════════════════════════
   GET /api/stock/:symbol?range=1M
════════════════════════════════════════════════════════════ */
export const getStockData = async (req, res) => {
  try {
    const originalSymbol = (req.params.symbol || "").toUpperCase().trim();
    const range          = (req.query.range   || "1M").toUpperCase();

    if (!originalSymbol)
      return res.status(400).json({ error: "Stock symbol is required." });
    if (!VALID_RANGES.has(range))
      return res.status(400).json({ error: `Invalid range "${range}". Valid: 1W 1M 3M 6M 1Y 5Y` });

    // ^NSEI → NIFTY50.NS; regular symbols pass through unchanged
    const symbol = normalizeSymbol(originalSymbol);

    // Cache key uses originalSymbol so ^NSEI and NIFTY50.NS never share an entry
    const cKey = serverCacheKey(originalSymbol, range);
    const hit  = serverCacheGet(cKey);
    if (hit) {
      console.log(`⚡ Cache HIT: ${originalSymbol}:${range}`);
      return res.json(hit);
    }

    const raw     = await fetchStock(symbol, range);
    const payload = attachIndicators(raw, range, originalSymbol);

    serverCacheSet(cKey, payload, serverCacheTTL(range));
    return res.json(payload);

  } catch (err) {
    const originalSymbol = (req?.params?.symbol || "").toUpperCase();

    if (/no data|empty|not found|unsupported/i.test(err.message)) {
      return res.status(404).json({
        error:  `No data available for "${originalSymbol}". Check the symbol and try again.`,
        symbol: originalSymbol,
      });
    }

    console.error(`getStockData FATAL [${originalSymbol}]:`, err.message);
    return res.status(500).json({
      error:  err.message.length > 300
                ? "Stock data fetch failed. Please try again."
                : err.message,
      symbol: originalSymbol,
    });
  }
};

/* ════════════════════════════════════════════════════════════
   POST /api/stock/batch
   Body: { symbols: string[], range?: string }
════════════════════════════════════════════════════════════ */
const fetchOne = async (originalSymbol, range) => {
  const symbol = normalizeSymbol(originalSymbol);
  const cKey   = serverCacheKey(originalSymbol, range);
  const hit    = serverCacheGet(cKey);
  if (hit) {
    console.log(`⚡ Batch cache HIT: ${originalSymbol}`);
    return hit;
  }
  const raw     = await fetchStock(symbol, range);
  const payload = attachIndicators(raw, range, originalSymbol);
  serverCacheSet(cKey, payload, serverCacheTTL(range));
  return payload;
};

export const getBatchStockData = async (req, res) => {
  try {
    const { symbols, range = "1W" } = req.body;

    if (!Array.isArray(symbols) || symbols.length === 0)
      return res.status(400).json({ error: "symbols must be a non-empty array" });
    if (symbols.length > 20)
      return res.status(400).json({ error: "Maximum 20 symbols per batch request" });
    if (!VALID_RANGES.has(range.toUpperCase()))
      return res.status(400).json({ error: `Invalid range "${range}"` });

    const results = {};

    await Promise.allSettled(
      symbols.map(async (rawSym) => {
        const sym = String(rawSym).toUpperCase().trim();
        if (!sym) return;
        try {
          results[sym] = await fetchOne(sym, range.toUpperCase());
        } catch (err) {
          console.warn(`Batch failed for ${sym}: ${err.message}`);
          results[sym] = { error: err.message || "Failed to fetch" };
        }
      })
    );

    const successCount = Object.values(results).filter((v) => !v.error).length;
    console.log(`✅ Batch complete: ${successCount}/${symbols.length} symbols`);

    return res.json({ results });

  } catch (err) {
    console.error("getBatchStockData FATAL:", err.message);
    return res.status(500).json({ error: "Batch fetch failed. Please try again." });
  }
};

/* ════════════════════════════════════════════════════════════
   LIVE STOCK — used by socketManager (WebSocket)
════════════════════════════════════════════════════════════ */
export const getLiveStock = getLiveStockData;

/* ════════════════════════════════════════════════════════════
   GET /api/stock/health
════════════════════════════════════════════════════════════ */
export const getProviderHealth = (_req, res) => res.json(getHealthStats());

/* ════════════════════════════════════════════════════════════
   GET /api/stock/:symbol/quick
   Lightweight Dashboard API — returns live price only, no candles.
════════════════════════════════════════════════════════════ */
export const getQuickStock = async (req, res) => {
  try {
    const originalSymbol = (req.params.symbol || "").toUpperCase().trim();
    if (!originalSymbol)
      return res.status(400).json({ error: "Stock symbol is required." });

    // Normalize: ^NSEI → NIFTY50.NS (no-op for regular symbols)
    const finalSymbol = normalizeSymbol(originalSymbol);

    let live;
    try {
      live = await getLiveStockData(finalSymbol);
    } catch (err) {
      console.warn(`Quick API fetch failed for ${finalSymbol}:`, err.message);
      return res.status(404).json({
        error:  "Stock data not available",
        symbol: originalSymbol,
      });
    }

    if (!live || live.price == null)
      return res.status(404).json({
        error:  "Invalid or unsupported stock symbol",
        symbol: originalSymbol,
      });

    const currentPrice  = Number(live.price);
    const prevClose     = Number(live.prevClose || currentPrice);
    const change        = +(currentPrice - prevClose).toFixed(2);
    const changePercent = prevClose
      ? +((change / prevClose) * 100).toFixed(2)
      : 0;
    const currency = finalSymbol.endsWith(".NS") ? "INR" : "USD";

    return res.json({
      symbol:        originalSymbol,             // return what the client sent
      type:          getSymbolType(originalSymbol),
      price:         currentPrice,
      change,
      changePercent,
      currency,
    });

  } catch (err) {
    console.error(`getQuickStock ERROR [${req?.params?.symbol}]:`, err.message);
    return res.status(500).json({
      error:  "Failed to fetch quick stock data",
      symbol: (req?.params?.symbol || "").toUpperCase(),
    });
  }
};