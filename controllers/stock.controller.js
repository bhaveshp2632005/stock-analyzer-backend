/**
 * stock.controller.js — Refactored with Multi-Provider Engine
 *
 * Controller is now lean:
 *  1. Cache check (stockCache.js)
 *  2. Call providerEngine.fetchStock() — handles all provider logic
 *  3. Attach RSI / MACD / signal indicators
 *  4. Cache the result
 *  5. Return to client
 *
 * API endpoints unchanged:
 *  GET  /api/stock/:symbol?range=1M
 *  POST /api/stock/batch
 */

import { calculateRSI, calculateMACD } from "../utils/indicators.js";
import { fetchStock, getLiveStockData, getHealthStats } from "../providers/providerEngine.js";
import {
  serverCacheGet,
  serverCacheSet,
  serverCacheKey,
  serverCacheTTL,
} from "./stockCache.js";

/* ── Valid ranges ── */
const VALID_RANGES = new Set(["1W", "1M", "3M", "6M", "1Y", "5Y"]);

/* ── Indicator helpers ── */
const rsiSeries  = (closes) =>
  closes.map((_, i) => i < 14 ? null : calculateRSI(closes.slice(i - 14, i + 1)));

const macdSeries = (closes) =>
  closes.map((_, i) => i < 26 ? null : calculateMACD(closes.slice(0, i + 1)));

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

/**
 * attachIndicators(engineResult) — adds RSI/MACD/signal to candles
 * Returns a fully-formed API response payload.
 */
const attachIndicators = (data, range) => {
  const closes     = data.candles.map(c => c.close);
  const rsi        = rsiSeries(closes);
  const macd       = macdSeries(closes);
  const latestRSI  = rsi[rsi.length - 1];
  const latestMACD = macd[macd.length - 1];
  const sig        = getSignal(latestRSI, latestMACD);

  return {
    symbol:        data.symbol,
    name:          data.name,
    price:         data.price,
    open:          data.open,
    high:          data.high,
    low:           data.low,
    prevClose:     data.prevClose,
    changePercent: data.changePercent,
    currency:      data.currency,
    exchange:      data.exchange,
    indicators: {
      rsi:    latestRSI,
      macd:   latestMACD,
      signal: sig,
    },
    chart: data.candles.map((c, i) => ({
      ...c,
      rsi:    rsi[i],
      macd:   macd[i],
      signal: rowSig(rsi[i], macd[i]),
    })),
    range,
    provider:   data.provider,   // which provider actually served this
    fetchedAt:  data.fetchedAt,
  };
};

/* ════════════════════════════════════════════════════════════
   MAIN HANDLER   GET /api/stock/:symbol?range=1M
════════════════════════════════════════════════════════════ */
export const getStockData = async (req, res) => {
  try {
    const symbol = (req.params.symbol || "").toUpperCase().trim();
    const range  = (req.query.range   || "1M").toUpperCase();

    if (!symbol)             return res.status(400).json({ error: "Stock symbol is required." });
    if (!VALID_RANGES.has(range)) return res.status(400).json({ error: `Invalid range "${range}". Valid: 1W 1M 3M 6M 1Y 5Y` });

    /* ── Cache check ── */
    const cKey = serverCacheKey(symbol, range);
    const hit  = serverCacheGet(cKey);
    if (hit) {
      console.log(`⚡ Cache HIT: ${symbol}:${range}`);
      return res.json(hit);
    }

    /* ── Fetch via engine ── */
    const raw     = await fetchStock(symbol, range);
    const payload = attachIndicators(raw, range);

    /* ── Cache + respond ── */
    serverCacheSet(cKey, payload, serverCacheTTL(range));
    return res.json(payload);

  } catch (err) {
    console.error(`getStockData FATAL [${req?.params?.symbol}]:`, err.message);
    return res.status(500).json({
      error:  err.message.length > 300 ? "Stock data fetch failed. Please try again." : err.message,
      symbol: (req?.params?.symbol || "").toUpperCase(),
    });
  }
};

/* ════════════════════════════════════════════════════════════
   BATCH HANDLER   POST /api/stock/batch
   Body: { symbols: string[], range?: string }
════════════════════════════════════════════════════════════ */

/* Internal helper — reuse getStockData logic without req/res */
const fetchOne = async (symbol, range) => {
  const cKey = serverCacheKey(symbol, range);
  const hit  = serverCacheGet(cKey);
  if (hit) {
    console.log(`⚡ Batch cache HIT: ${symbol}`);
    return hit;
  }
  const raw     = await fetchStock(symbol, range);
  const payload = attachIndicators(raw, range);
  serverCacheSet(cKey, payload, serverCacheTTL(range));
  return payload;
};

export const getBatchStockData = async (req, res) => {
  try {
    const { symbols, range = "1W" } = req.body;

    if (!Array.isArray(symbols) || symbols.length === 0) {
      return res.status(400).json({ error: "symbols must be a non-empty array" });
    }
    if (symbols.length > 20) {
      return res.status(400).json({ error: "Maximum 20 symbols per batch request" });
    }
    if (!VALID_RANGES.has(range.toUpperCase())) {
      return res.status(400).json({ error: `Invalid range "${range}"` });
    }

    const results = {};

    await Promise.allSettled(
      symbols.map(async (rawSym) => {
        const symbol = String(rawSym).toUpperCase().trim();
        if (!symbol) return;
        try {
          results[symbol] = await fetchOne(symbol, range.toUpperCase());
        } catch (err) {
          console.warn(`Batch failed for ${symbol}: ${err.message}`);
          results[symbol] = { error: err.message || "Failed to fetch" };
        }
      })
    );

    const successCount = Object.values(results).filter(v => !v.error).length;
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
   HEALTH STATS   GET /api/stock/health  (optional debug route)
════════════════════════════════════════════════════════════ */
export const getProviderHealth = (_req, res) => {
  return res.json(getHealthStats());
};
/* ════════════════════════════════════════════════════════════
   QUICK STOCK — Lightweight Dashboard API
   GET /api/stock/:symbol/quick
════════════════════════════════════════════════════════════ */
export const getQuickStock = async (req, res) => {
  try {
    const symbol = (req.params.symbol || "").toUpperCase().trim();
    if (!symbol) {
      return res.status(400).json({ error: "Stock symbol is required." });
    }

    // 🔹 Use existing lightweight live stock function (FAST)
    const live = await getLiveStockData(symbol);

    if (!live || live.price == null) {
      return res.status(404).json({ error: "Invalid or unsupported stock symbol." });
    }

    const currentPrice  = Number(live.price);
    const prevClose     = Number(live.prevClose || currentPrice);

    const change        = +(currentPrice - prevClose).toFixed(2);
    const changePercent = prevClose
      ? +(((change) / prevClose) * 100).toFixed(2)
      : 0;

    const currency = symbol.endsWith(".NS") ? "INR" : "USD";

    return res.json({
      symbol,
      price: currentPrice,
      change,
      changePercent,
      currency,
    });

  } catch (err) {
    console.error(`getQuickStock ERROR [${req?.params?.symbol}]:`, err.message);

    return res.status(500).json({
      error: "Failed to fetch quick stock data",
      symbol: (req?.params?.symbol || "").toUpperCase(),
    });
  }
};