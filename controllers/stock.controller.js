/**
 * controllers/stock.controller.js
 *
 * Supports ALL asset classes via the smart provider router:
 *   US stocks/ETFs, Indian NSE/BSE, Indian/US/Global indices,
 *   Crypto, Forex, UK/Japan/Germany/HK/Canada/Australia stocks
 *
 * Flow:
 *  1. normalizeSymbol() — ^NSEI/NSEI → NIFTY50.NS, everything else unchanged
 *  2. Cache check
 *  3. fetchStock() — smart router picks best providers per asset type
 *  4. attachIndicators() — RSI + MACD + EMA(20) + signal
 *  5. Return with originalSymbol + type tag
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

const VALID_RANGES = new Set(["1W", "1M", "3M", "6M", "1Y", "5Y"]);
const EMA_PERIOD   = 20;

/* ── Indicator series ── */
const rsiSeries  = (closes) =>
  closes.map((_, i) => (i < 14 ? null : calculateRSI(closes.slice(i - 14, i + 1))));

const macdSeries = (closes) =>
  closes.map((_, i) => (i < 26 ? null : calculateMACD(closes.slice(0, i + 1))));

const getSignal  = (rsi, macd) => {
  if (rsi == null || macd == null) return "HOLD";
  if (rsi < 35 && macd > 0) return "BUY";
  if (rsi > 65 && macd < 0) return "SELL";
  return "HOLD";
};

const rowSig = (rsi, macd) => {
  const s = getSignal(rsi, macd);
  return s === "HOLD" ? null : s;
};

/* ── attachIndicators ── */
const attachIndicators = (data, range, originalSymbol) => {
  const closes     = data.candles.map(c => c.close);
  const rsi        = rsiSeries(closes);
  const macd       = macdSeries(closes);
  const ema        = emaSeries(closes, EMA_PERIOD);
  const latestRSI  = rsi[rsi.length - 1];
  const latestMACD = macd[macd.length - 1];
  const latestEMA  = ema[ema.length - 1];
  const sig        = getSignal(latestRSI, latestMACD);

  const displayName = getDisplayName(originalSymbol);
  const name = displayName !== originalSymbol ? displayName : (data.name || originalSymbol);

  return {
    symbol:        originalSymbol,
    normalizedAs:  data.symbol,
    type:          getSymbolType(originalSymbol),
    name,
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
      ema:    latestEMA,
      signal: sig,
    },
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

    // Normalize: ^NSEI / NSEI → NIFTY50.NS; everything else unchanged
    const symbol = normalizeSymbol(originalSymbol);

    // Cache keyed on originalSymbol so ^NSEI and NIFTY50.NS never collide
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
    const sym = (req?.params?.symbol || "").toUpperCase();

    if (/no data|empty|not found|unsupported|invalid/i.test(err.message)) {
      return res.status(404).json({
        error:  `No data available for "${sym}". Check the symbol and try again.`,
        symbol: sym,
      });
    }

    console.error(`getStockData FATAL [${sym}]:`, err.message);
    return res.status(500).json({
      error:  err.message.length > 300 ? "Stock data fetch failed. Please try again." : err.message,
      symbol: sym,
    });
  }
};

/* ════════════════════════════════════════════════════════════
   POST /api/stock/batch
════════════════════════════════════════════════════════════ */
const fetchOne = async (originalSymbol, range) => {
  const symbol = normalizeSymbol(originalSymbol);
  const cKey   = serverCacheKey(originalSymbol, range);
  const hit    = serverCacheGet(cKey);
  if (hit) return hit;

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
          results[sym] = { error: err.message || "Failed to fetch" };
        }
      })
    );

    const ok = Object.values(results).filter(v => !v.error).length;
    console.log(`✅ Batch: ${ok}/${symbols.length} symbols`);
    return res.json({ results });

  } catch (err) {
    console.error("getBatchStockData FATAL:", err.message);
    return res.status(500).json({ error: "Batch fetch failed." });
  }
};

/* ════════════════════════════════════════════════════════════
   LIVE STOCK — WebSocket
════════════════════════════════════════════════════════════ */
export const getLiveStock = getLiveStockData;

/* ════════════════════════════════════════════════════════════
   GET /api/stock/health
════════════════════════════════════════════════════════════ */
export const getProviderHealth = (_req, res) => res.json(getHealthStats());

/* ════════════════════════════════════════════════════════════
   GET /api/stock/:symbol/quick
════════════════════════════════════════════════════════════ */
export const getQuickStock = async (req, res) => {
  try {
    const originalSymbol = (req.params.symbol || "").toUpperCase().trim();
    if (!originalSymbol)
      return res.status(400).json({ error: "Stock symbol is required." });

    const finalSymbol = normalizeSymbol(originalSymbol);

    let live;
    try {
      live = await getLiveStockData(finalSymbol);
    } catch (err) {
      console.warn(`Quick fetch failed for ${finalSymbol}: ${err.message}`);
      return res.status(404).json({ error: "Stock data not available", symbol: originalSymbol });
    }

    if (!live || live.price == null)
      return res.status(404).json({ error: "Invalid or unsupported symbol", symbol: originalSymbol });

    const currentPrice  = Number(live.price);
    const prevClose     = Number(live.prevClose || currentPrice);
    const change        = +(currentPrice - prevClose).toFixed(2);
    const changePercent = prevClose ? +((change / prevClose) * 100).toFixed(2) : 0;

    return res.json({
      symbol:        originalSymbol,
      type:          getSymbolType(originalSymbol),
      price:         currentPrice,
      change,
      changePercent,
      currency:      live.currency || (finalSymbol.endsWith(".NS") ? "INR" : "USD"),
    });

  } catch (err) {
    console.error(`getQuickStock ERROR [${req?.params?.symbol}]:`, err.message);
    return res.status(500).json({
      error:  "Failed to fetch quick stock data",
      symbol: (req?.params?.symbol || "").toUpperCase(),
    });
  }
};