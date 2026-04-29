/**
 * ai.controller.js — Node.js ↔ Python AI Engine bridge v5.2
 * ═══════════════════════════════════════════════════════════
 *
 * v5.2 FIX: Root cause of 422 errors diagnosed and fixed.
 *
 * ROOT CAUSE:
 *   Python's _chart_to_df() is strict about field names AND types.
 *   Your stock controller spreads provider candles with attachIndicators(),
 *   so each candle row may contain:
 *     - Wrong date field name: "t", "datetime", "timestamp" → must be "date"
 *     - Unix epoch integers (Finnhub returns seconds, not ISO strings)
 *     - Extra fields: rsi, macd, ema, signal (harmless but messy)
 *     - Null/undefined OHLCV values on bad rows
 *     - String prices instead of numbers (some providers return "150.23")
 *
 *   Python accepts date field named: date | timestamp | time | datetime
 *   Python REQUIRES: open, high, low, close (volume optional)
 *   Python DROPS rows where close <= 0 after pd.to_numeric coercion
 *
 * FIX APPLIED — normalizeCandles():
 *   Runs on every candle array before it is sent to Python.
 *   1. Finds date field regardless of what provider named it
 *   2. Converts Unix epoch (seconds or ms) → ISO date string "YYYY-MM-DD"
 *   3. Ensures open/high/low/close/volume are numbers, not strings
 *   4. Drops rows missing close or with close <= 0
 *   5. Strips extra fields (rsi, macd, ema, signal) to keep payload lean
 *   Output is always: [ { date, open, high, low, close, volume }, ... ]
 *
 * Everything else (caching, MIN_CANDLES guard, DB persistence,
 * all other endpoints) — unchanged from v5.1.
 */
import axios    from "axios";
import Analysis from "../models/Analysis.model.js";

const AI_BASE    = process.env.AI_ENGINE_URL || "http://localhost:8000";
const AI_TIMEOUT = Number(process.env.AI_TIMEOUT_MS) || 300_000;

const aiClient = axios.create({
  baseURL: AI_BASE,
  timeout: AI_TIMEOUT,
  headers: { "Content-Type": "application/json" },
});

// ── In-memory TTL cache ───────────────────────────────────────────────────────
const _cache    = new Map();
const CACHE_TTL = Number(process.env.AI_CACHE_TTL_MS) || 900_000;

const cget = (k) => {
  const e = _cache.get(k);
  if (!e) return null;
  if (Date.now() - e.ts > CACHE_TTL) { _cache.delete(k); return null; }
  return e.data;
};
const cset = (k, d) => _cache.set(k, { data: d, ts: Date.now() });

// ── Error handler ─────────────────────────────────────────────────────────────
const handleErr = (res, err, ctx) => {
  if (err.code === "ECONNREFUSED")
    return res.status(503).json({
      message: "AI Engine offline. Start with: uvicorn main:app --port 8000",
      ctx,
    });
  if (err.response?.status === 422)
    return res.status(422).json({
      message: err.response.data?.detail || "Invalid input",
      ctx,
    });
  if (err.code === "ECONNABORTED" || err.code === "ETIMEDOUT")
    return res.status(504).json({ message: "AI Engine timed out", ctx });

  console.error(`[AI] ${ctx}:`, err.message);
  return res.status(500).json({ message: `${ctx} failed: ${err.message}` });
};

// ══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ══════════════════════════════════════════════════════════════════════════════

const MIN_CANDLES  = 200;
const FETCH_RANGES = ["5Y", "1Y"];

// ══════════════════════════════════════════════════════════════════════════════
// v5.2 CORE FIX: normalizeCandles()
// Converts any provider candle shape → clean { date, open, high, low, close, volume }
// ══════════════════════════════════════════════════════════════════════════════

// All known date field names across providers:
//   Yahoo Finance : "date"         (JS Date object or ISO string)
//   Finnhub       : "t"            (Unix seconds integer)
//   TwelveData    : "datetime"     (ISO string "2024-01-15 09:30:00")
//   AlphaVantage  : "timestamp"    (ISO string)
//   NSE India     : "CH_TIMESTAMP"
const DATE_FIELD_CANDIDATES = [
  "date", "datetime", "timestamp", "time",
  "t", "ts", "Date", "DateTime", "Timestamp",
  "CH_TIMESTAMP", "lastUpdateTime",
];

// OHLCV field aliases across providers
const FIELD_MAP = {
  open:   ["open",   "o", "Open",   "1. open"],
  high:   ["high",   "h", "High",   "2. high"],
  low:    ["low",    "l", "Low",    "3. low"],
  close:  ["close",  "c", "Close",  "4. close", "adjClose", "adj_close"],
  volume: ["volume", "v", "Volume", "5. volume"],
};

/**
 * toISODate — convert any date representation to "YYYY-MM-DD" string.
 * Handles: ISO strings, JS Date objects, Unix seconds, Unix milliseconds.
 */
const toISODate = (value) => {
  if (!value && value !== 0) return null;

  if (typeof value === "string") {
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  }

  if (value instanceof Date) {
    if (isNaN(value.getTime())) return null;
    return value.toISOString().slice(0, 10);
  }

  const num = Number(value);
  if (!isNaN(num) && num > 0) {
    // 10-digit = Unix seconds, 13-digit = Unix milliseconds
    const ms = num < 1e12 ? num * 1000 : num;
    const d  = new Date(ms);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }

  const d = new Date(value);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);

  return null;
};

const findField = (candle, candidates) => {
  for (const key of candidates) {
    if (candle[key] !== undefined && candle[key] !== null) return candle[key];
  }
  return undefined;
};

/**
 * normalizeCandles — the main fix.
 * Input:  any provider candle array
 * Output: clean [ { date: "YYYY-MM-DD", open, high, low, close, volume } ]
 */
export const normalizeCandles = (rawCandles) => {
  if (!Array.isArray(rawCandles) || rawCandles.length === 0) return [];

  // Auto-detect date field from first candle
  const sample           = rawCandles.find(c => c && typeof c === "object") || {};
  const sampleKeys       = Object.keys(sample);
  const detectedDateField = DATE_FIELD_CANDIDATES.find(f => sampleKeys.includes(f));

  if (!detectedDateField) {
    console.warn(
      "[AI] normalizeCandles: no date field found. " +
      `Sample keys: ${sampleKeys.slice(0, 10).join(", ")}`
    );
  }

  const normalized = [];

  for (const candle of rawCandles) {
    if (!candle || typeof candle !== "object") continue;

    // Date
    const rawDate = detectedDateField
      ? candle[detectedDateField]
      : findField(candle, DATE_FIELD_CANDIDATES);
    const date = toISODate(rawDate);
    if (!date) continue;

    // OHLCV
    const open   = parseFloat(findField(candle, FIELD_MAP.open)   ?? NaN);
    const high   = parseFloat(findField(candle, FIELD_MAP.high)   ?? NaN);
    const low    = parseFloat(findField(candle, FIELD_MAP.low)    ?? NaN);
    const close  = parseFloat(findField(candle, FIELD_MAP.close)  ?? NaN);
    const volume = parseFloat(findField(candle, FIELD_MAP.volume) ?? 0) || 0;

    // Validation — drop rows Python would drop anyway
    if (isNaN(close) || close <= 0)                 continue;
    if (isNaN(open)  || isNaN(high) || isNaN(low))  continue;

    normalized.push({ date, open, high, low, close, volume });
  }

  return normalized;
};

// ══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════════════════════

const extractCandles = (data) =>
  Array.isArray(data)
    ? data
    : data?.chart || data?.history || data?.candles || data?.data || [];

const NODE_BASE  = process.env.NODE_INTERNAL_URL || "http://localhost:5000";
const nodeClient = axios.create({ baseURL: NODE_BASE, timeout: 20_000 });

async function fetchChartData(symbol, authHeader) {
  const headers = authHeader ? { Authorization: authHeader } : {};

  // Strategy 1: /api/stock/:symbol?range=X
  for (const range of FETCH_RANGES) {
    try {
      const { data } = await nodeClient.get(
        `/api/stock/${symbol}`,
        { params: { range }, headers }
      );
      const raw     = extractCandles(data);
      const candles = normalizeCandles(raw);

      if (candles.length >= MIN_CANDLES) {
        const last = candles[candles.length - 1];
        console.log(`[AI] ${symbol}: ${candles.length} clean candles via /api/stock?range=${range}`);
        return {
          chart:        candles,
          currentPrice: last?.close ?? null,
          indicators:   data?.indicators ?? data?.technicals ?? null,
        };
      }
      console.warn(
        `[AI] ${symbol} range=${range}: ${candles.length} valid candles` +
        ` (raw: ${raw.length}) — need ${MIN_CANDLES}`
      );
    } catch (e) {
      console.warn(`[AI] /api/stock/${symbol}?range=${range}:`, e.message);
    }
  }

  // Strategy 2: /api/stock/history/:symbol
  for (const range of FETCH_RANGES) {
    try {
      const { data } = await nodeClient.get(
        `/api/stock/history/${symbol}`,
        { params: { range, interval: "1d" }, headers }
      );
      const candles = normalizeCandles(extractCandles(data));
      if (candles.length >= MIN_CANDLES) {
        console.log(`[AI] ${symbol}: ${candles.length} clean candles via /api/stock/history?range=${range}`);
        return { chart: candles, currentPrice: candles.at(-1)?.close ?? null, indicators: null };
      }
    } catch (e) {
      console.warn(`[AI] /api/stock/history/${symbol}?range=${range}:`, e.message);
    }
  }

  // Strategy 3: /api/stock/chart/:symbol
  try {
    const { data } = await nodeClient.get(`/api/stock/chart/${symbol}`, { headers });
    const candles  = normalizeCandles(extractCandles(data));
    if (candles.length >= MIN_CANDLES) {
      console.log(`[AI] ${symbol}: ${candles.length} clean candles via /api/stock/chart`);
      return { chart: candles, currentPrice: candles.at(-1)?.close ?? null, indicators: null };
    }
    console.warn(`[AI] /api/stock/chart/${symbol}: ${candles.length} valid candles — need ${MIN_CANDLES}`);
  } catch (e) {
    console.warn(`[AI] /api/stock/chart/${symbol}:`, e.message);
  }

  console.error(`[AI] Could not get ${MIN_CANDLES}+ valid candles for ${symbol}`);
  return null;
}

// ══════════════════════════════════════════════════════════════════════════════
// CONTROLLERS
// ══════════════════════════════════════════════════════════════════════════════

export const analyzeQuick = async (req, res) => {
  try {
    const { data } = await aiClient.post("/analyze", req.body);
    return res.json(data);
  } catch (err) {
    if (err.code === "ECONNREFUSED")
      return res.json({ action: "HOLD", confidence: 30,
                        summary: "AI Engine offline — showing neutral signal", score: 0 });
    return handleErr(res, err, "QuickAnalyze");
  }
};

export const predict = async (req, res) => {
  const {
    symbol,
    horizon         = 5,
    skipSentiment   = false,
    includeChart    = false,
    includeBacktest = false,
    includeRisk     = true,
    lstmEpochs      = 60,
    chart: chartFromFrontend  = null,
    indicators: indFromFront  = null,
    currentPrice: cpFromFront = null,
    currency                  = "USD",
  } = req.body;

  if (!symbol) return res.status(400).json({ message: "symbol required" });

  const sym = symbol.toUpperCase().trim();
  const ck  = `predict:${sym}:${horizon}`;

  const cached = cget(ck);
  if (cached) return res.json({ ...cached, fromCache: true });

  console.log(`[AI] Predict: ${sym} horizon=${horizon}d`);

  // Step 1: Normalize frontend candles (they may be in provider format)
  let chart        = chartFromFrontend ? normalizeCandles(chartFromFrontend) : null;
  let indicators   = indFromFront;
  let currentPrice = cpFromFront;

  // Step 2: Fetch from stock service if not enough candles
  if (!chart || chart.length < MIN_CANDLES) {
    if (chart?.length) {
      console.log(`[AI] ${sym}: only ${chart.length} valid candles from frontend, fetching more…`);
    }
    const fetched = await fetchChartData(sym, req.headers.authorization);

    if (fetched?.chart?.length >= MIN_CANDLES) {
      chart        = fetched.chart;
      currentPrice = fetched.currentPrice ?? currentPrice;
      indicators   = fetched.indicators   ?? indicators;
      console.log(`[AI] ${sym}: using ${chart.length} normalized candles`);
    } else {
      const available = fetched?.chart?.length ?? chart?.length ?? 0;
      console.error(`[AI] ${sym}: insufficient data — ${available} valid candles`);
      return res.status(422).json({
        message:
          `Insufficient historical data for ${sym}. ` +
          `Got ${available} valid candles but need at least ${MIN_CANDLES}. ` +
          `Ensure your stock data provider returns at least 1 year of daily OHLCV data.`,
        symbol: sym, available, required: MIN_CANDLES,
      });
    }
  }

  // Step 3: Belt-and-suspenders guard
  if (!chart || chart.length < MIN_CANDLES) {
    return res.status(422).json({
      message: `chart[] must have at least ${MIN_CANDLES} candles. Got ${chart?.length ?? 0}.`,
      symbol: sym, available: chart?.length ?? 0, required: MIN_CANDLES,
    });
  }

  // Step 4: Sanity check shape before sending
  const first = chart[0];
  const last  = chart[chart.length - 1];
  if (!first?.date || !first?.close || !last?.date || !last?.close) {
    console.error(`[AI] Bad candle shape after normalization:`, { first, last });
    return res.status(422).json({
      message: "Candle data has invalid shape. Each row must have: date (YYYY-MM-DD string), open, high, low, close (numbers).",
      sample: { first, last },
    });
  }

  // Step 5: Send to Python
  const payload = {
    symbol: sym, horizon,
    skip_sentiment:   skipSentiment,
    include_chart:    includeChart,
    include_backtest: includeBacktest,
    include_risk:     includeRisk,
    lstm_epochs:      lstmEpochs,
    currency,
    chart,            // always: [ { date, open, high, low, close, volume } ]
    current_price:    currentPrice,
    indicators,
  };

  console.log(
    `[AI] Sending ${chart.length} candles for ${sym}` +
    ` | ${first.date}→${last.date}` +
    ` | close: ${first.close}→${last.close}`
  );

  try {
    const { data } = await aiClient.post("/predict", payload);

    if (req.user?.id) {
      Analysis.findOneAndUpdate(
        { userId: req.user.id, symbol: sym },
        {
          $set: {
            price:      String(data.currentPrice ?? currentPrice ?? ""),
            signal:     data.trend === "Bullish" ? "BUY"
                      : data.trend === "Bearish" ? "SELL" : "HOLD",
            confidence: data.confidence ?? 0,
            summary:    [
              `${data.trend} +${data.predictedReturn?.toFixed(2)}%`,
              `Regime: ${data.marketRegime?.currentRegime ?? "N/A"}`,
              `Sentiment: ${data.sentiment?.label ?? "N/A"}`,
            ].join(" | "),
            date: new Date().toISOString().split("T")[0],
          },
        },
        { upsert: true, new: true }
      ).catch(() => {});
    }

    cset(ck, data);
    return res.json({ ...data, fromCache: false });
  } catch (err) {
    return handleErr(res, err, "Predict");
  }
};

export const regime = async (req, res) => {
  const sym = req.params.symbol.toUpperCase().trim();
  const ck  = `regime:${sym}`;
  const cached = cget(ck);
  if (cached) return res.json({ ...cached, fromCache: true });
  try {
    const { data } = await aiClient.get(`/regime/${sym}`);
    cset(ck, data);
    return res.json({ ...data, fromCache: false });
  } catch (err) { return handleErr(res, err, "Regime"); }
};

export const sentiment = async (req, res) => {
  const sym = req.params.symbol.toUpperCase().trim();
  const ck  = `sent:${sym}`;
  const cached = cget(ck);
  if (cached) return res.json({ ...cached, fromCache: true });
  try {
    const { data } = await aiClient.get(`/sentiment/${sym}`);
    cset(ck, data);
    return res.json({ ...data, fromCache: false });
  } catch (err) { return handleErr(res, err, "Sentiment"); }
};

export const portfolioOptimize = async (req, res) => {
  const { symbols, method = "max_sharpe", regime: reg = "Sideways" } = req.body;
  if (!symbols?.length) return res.status(400).json({ message: "symbols required" });
  try {
    const { data } = await aiClient.post("/portfolio", {
      symbols: symbols.map((s) => s.toUpperCase()),
      method, regime: reg,
    });
    return res.json(data);
  } catch (err) { return handleErr(res, err, "Portfolio"); }
};

export const risk = async (req, res) => {
  const sym = req.params.symbol.toUpperCase().trim();
  try {
    const { data } = await aiClient.get(`/risk/${sym}`);
    return res.json(data);
  } catch (err) { return handleErr(res, err, "Risk"); }
};

export const backtest = async (req, res) => {
  const { symbol, initialCash = 100000, signalThreshold = 1.5,
          stopLossPct = 0.06, takeProfitPct = 0.12 } = req.body;
  if (!symbol) return res.status(400).json({ message: "symbol required" });
  try {
    const { data } = await aiClient.post("/backtest", {
      symbol:           symbol.toUpperCase(),
      initial_cash:     initialCash,
      signal_threshold: signalThreshold,
      stop_loss_pct:    stopLossPct,
      take_profit_pct:  takeProfitPct,
    });
    return res.json(data);
  } catch (err) { return handleErr(res, err, "Backtest"); }
};

export const indicators = async (req, res) => {
  const sym = req.params.symbol.toUpperCase().trim();
  try {
    const { data } = await aiClient.get(`/indicators/${sym}`, {
      params: { n_days: Number(req.query.n) || 30 },
    });
    return res.json(data);
  } catch (err) { return handleErr(res, err, "Indicators"); }
};

export const chart = async (req, res) => {
  const sym = req.params.symbol.toUpperCase().trim();
  try {
    const { data } = await aiClient.get(`/chart/${sym}`, {
      params: { chart_type: req.query.type || "price" },
    });
    return res.json(data);
  } catch (err) { return handleErr(res, err, "Chart"); }
};

export const timeframes = async (req, res) => {
  const sym = req.params.symbol.toUpperCase().trim();
  try {
    const { data } = await aiClient.get(`/timeframes/${sym}`);
    return res.json(data);
  } catch (err) { return handleErr(res, err, "Timeframes"); }
};

export const macro = async (req, res) => {
  const ck = "macro:latest";
  const cached = cget(ck);
  if (cached) return res.json({ ...cached, fromCache: true });
  try {
    const { data } = await aiClient.get("/macro");
    cset(ck, data);
    return res.json({ ...data, fromCache: false });
  } catch (err) { return handleErr(res, err, "Macro"); }
};

export const rlTrain = async (req, res) => {
  const { symbol, algorithm = "PPO", totalTimesteps = 30000 } = req.body;
  if (!symbol) return res.status(400).json({ message: "symbol required" });
  try {
    const { data } = await aiClient.post("/rl/train", {
      symbol:          symbol.toUpperCase(),
      algorithm,
      total_timesteps: totalTimesteps,
    });
    return res.json(data);
  } catch (err) { return handleErr(res, err, "RLTrain"); }
};

export const rlEvaluate = async (req, res) => {
  const sym = req.params.symbol.toUpperCase().trim();
  try {
    const { data } = await aiClient.get(`/rl/evaluate/${sym}`, {
      params: { algorithm: req.query.algorithm || "PPO" },
    });
    return res.json(data);
  } catch (err) { return handleErr(res, err, "RLEvaluate"); }
};

export const health = async (_req, res) => {
  try {
    const { data } = await aiClient.get("/health", { timeout: 5000 });
    return res.json({ nodeStatus: "ok", aiStatus: data.status, ...data });
  } catch (_) {
    return res.status(503).json({
      nodeStatus: "ok",
      aiStatus:   "unreachable",
      message:    "Python AI service not running. Start: uvicorn main:app --port 8000",
    });
  }
};