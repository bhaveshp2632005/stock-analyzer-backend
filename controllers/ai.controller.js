/**
 * ai.controller.js — Node.js ↔ Python AI Engine bridge v5.3
 * ═══════════════════════════════════════════════════════════
 *
 * v5.3 ROOT CAUSE FIX:
 *
 *   PROBLEM: Yahoo Finance returns WEEKLY candles for long ranges (5Y, 1Y).
 *   61 weekly candles = ~14 months of data. normalizeCandles() correctly
 *   counts them as 61 rows — nowhere near the 200 daily candles Python needs.
 *
 *   WHY: The stock controller passes range ("5Y") to fetchStock() → Yahoo,
 *   which auto-selects weekly interval for long date ranges to limit response
 *   size. There is no interval=1d param being sent.
 *
 *   FIX: ai.controller.js now fetches candles DIRECTLY from Yahoo Finance
 *   using the yahoo-finance2 library (already in your node_modules since
 *   your Yahoo provider uses it). This bypasses the stock controller entirely
 *   for the prediction data fetch, requesting daily interval explicitly:
 *     period1: 3 years ago
 *     interval: "1d"  ← forces daily candles
 *
 *   This guarantees 700-750 daily candles (3 years × ~252 trading days).
 *   The stock controller and all its endpoints are NOT changed.
 *
 *   FALLBACK CHAIN (if direct Yahoo fetch fails):
 *     1. Direct Yahoo Finance (daily, 3y)        → ~750 candles ✓
 *     2. Direct Yahoo Finance (daily, 2y)        → ~500 candles ✓
 *     3. Stock controller /api/stock/:symbol?range=5Y + interval=1d param
 *     4. Return 422 with clear message
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

const MIN_CANDLES = 200;

// ══════════════════════════════════════════════════════════════════════════════
// normalizeCandles — convert any provider format → Python-safe OHLCV rows
// ══════════════════════════════════════════════════════════════════════════════

const DATE_FIELD_CANDIDATES = [
  "date", "datetime", "timestamp", "time",
  "t", "ts", "Date", "DateTime", "Timestamp",
  "CH_TIMESTAMP", "lastUpdateTime",
];

const FIELD_MAP = {
  open:   ["open",   "o", "Open",   "1. open"],
  high:   ["high",   "h", "High",   "2. high"],
  low:    ["low",    "l", "Low",    "3. low"],
  close:  ["close",  "c", "Close",  "4. close", "adjClose", "adj_close"],
  volume: ["volume", "v", "Volume", "5. volume"],
};

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

export const normalizeCandles = (rawCandles) => {
  if (!Array.isArray(rawCandles) || rawCandles.length === 0) return [];

  const sample            = rawCandles.find(c => c && typeof c === "object") || {};
  const sampleKeys        = Object.keys(sample);
  const detectedDateField = DATE_FIELD_CANDIDATES.find(f => sampleKeys.includes(f));

  if (!detectedDateField) {
    console.warn(`[AI] normalizeCandles: no date field found. Keys: ${sampleKeys.slice(0, 10).join(", ")}`);
  }

  const normalized = [];

  for (const candle of rawCandles) {
    if (!candle || typeof candle !== "object") continue;

    const rawDate = detectedDateField
      ? candle[detectedDateField]
      : findField(candle, DATE_FIELD_CANDIDATES);
    const date = toISODate(rawDate);
    if (!date) continue;

    const open   = parseFloat(findField(candle, FIELD_MAP.open)   ?? NaN);
    const high   = parseFloat(findField(candle, FIELD_MAP.high)   ?? NaN);
    const low    = parseFloat(findField(candle, FIELD_MAP.low)    ?? NaN);
    const close  = parseFloat(findField(candle, FIELD_MAP.close)  ?? NaN);
    const volume = parseFloat(findField(candle, FIELD_MAP.volume) ?? 0) || 0;

    if (isNaN(close) || close <= 0)                continue;
    if (isNaN(open)  || isNaN(high) || isNaN(low)) continue;

    normalized.push({ date, open, high, low, close, volume });
  }

  return normalized;
};

// ══════════════════════════════════════════════════════════════════════════════
// PRIMARY FETCH: Direct Yahoo Finance with forced daily interval
// This is the v5.3 fix — bypasses stock controller to get daily candles.
// ══════════════════════════════════════════════════════════════════════════════

/**
 * fetchYahooDirect(symbol)
 *
 * Calls yahoo-finance2 directly (same library your Yahoo provider uses).
 * Forces interval="1d" so we always get daily candles, not weekly.
 *
 * Tries 3y first (~756 trading days), falls back to 2y (~504 days).
 * Both comfortably exceed the 200-candle minimum.
 */
async function fetchYahooDirect(symbol) {
  // Dynamic import — works whether yahoo-finance2 is ESM or CJS
  let yf;
  try {
    const mod = await import("yahoo-finance2");
    yf = mod.default ?? mod;
  } catch (e) {
    throw new Error(`yahoo-finance2 not available: ${e.message}`);
  }

  const ATTEMPTS = [
    { years: 3, label: "3y" },
    { years: 2, label: "2y" },
  ];

  for (const { years, label } of ATTEMPTS) {
    try {
      const period1 = new Date();
      period1.setFullYear(period1.getFullYear() - years);

      const result = await yf.chart(symbol, {
        period1,
        interval: "1d",   // ← THE FIX: always daily, never weekly
      });

      // yahoo-finance2 v2: result.quotes[]
      // yahoo-finance2 v1: result.timestamp[] + result.indicators.quote[0]
      let rows = [];

      if (result?.quotes?.length) {
        // v2 shape: [ { date: Date, open, high, low, close, volume }, ... ]
        rows = result.quotes;
      } else if (result?.timestamp && result?.indicators?.quote?.[0]) {
        // v1 shape: parallel arrays
        const { timestamp }           = result;
        const { open, high, low, close, volume } = result.indicators.quote[0];
        rows = timestamp.map((ts, i) => ({
          date:   new Date(ts * 1000),
          open:   open[i],
          high:   high[i],
          low:    low[i],
          close:  close[i],
          volume: volume[i] ?? 0,
        }));
      }

      const candles = normalizeCandles(rows);

      if (candles.length >= MIN_CANDLES) {
        console.log(
          `[AI] Yahoo direct (${label} daily): ${candles.length} candles for ${symbol}`
        );
        return {
          chart:        candles,
          currentPrice: candles.at(-1)?.close ?? null,
          indicators:   null,
        };
      }

      console.warn(
        `[AI] Yahoo direct (${label} daily): only ${candles.length} candles` +
        ` for ${symbol} — trying shorter period`
      );
    } catch (e) {
      console.warn(`[AI] Yahoo direct (${label}) failed for ${symbol}: ${e.message}`);
    }
  }

  return null;
}

// ══════════════════════════════════════════════════════════════════════════════
// FALLBACK FETCH: Stock controller endpoint (with interval hint)
// Used only if direct Yahoo fails (network issue, delisted symbol, etc.)
// ══════════════════════════════════════════════════════════════════════════════

const NODE_BASE  = process.env.NODE_INTERNAL_URL || "http://localhost:5000";
const nodeClient = axios.create({ baseURL: NODE_BASE, timeout: 20_000 });

const extractCandles = (data) =>
  Array.isArray(data)
    ? data
    : data?.chart || data?.history || data?.candles || data?.data || [];

async function fetchFromStockController(symbol, authHeader) {
  const headers = authHeader ? { Authorization: authHeader } : {};

  // Try with explicit interval=1d hint — stock controller may or may not
  // forward this to the provider, but it costs nothing to send.
  for (const range of ["5Y", "1Y"]) {
    try {
      const { data } = await nodeClient.get(
        `/api/stock/${symbol}`,
        { params: { range, interval: "1d" }, headers }
      );
      const raw     = extractCandles(data);
      const candles = normalizeCandles(raw);

      if (candles.length >= MIN_CANDLES) {
        console.log(
          `[AI] Stock controller (${range} + interval=1d):` +
          ` ${candles.length} candles for ${symbol}`
        );
        return {
          chart:        candles,
          currentPrice: candles.at(-1)?.close ?? null,
          indicators:   data?.indicators ?? null,
        };
      }
      console.warn(
        `[AI] Stock controller (${range}): ${candles.length} valid candles` +
        ` (raw: ${raw.length}) — need ${MIN_CANDLES}`
      );
    } catch (e) {
      console.warn(`[AI] Stock controller /api/stock/${symbol}?range=${range}:`, e.message);
    }
  }

  return null;
}

// ══════════════════════════════════════════════════════════════════════════════
// MASTER FETCH: tries direct Yahoo first, then stock controller
// ══════════════════════════════════════════════════════════════════════════════

async function fetchChartData(symbol, authHeader) {
  // 1. Direct Yahoo (daily interval — the reliable path)
  try {
    const result = await fetchYahooDirect(symbol);
    if (result?.chart?.length >= MIN_CANDLES) return result;
  } catch (e) {
    console.warn(`[AI] fetchYahooDirect failed for ${symbol}: ${e.message}`);
  }

  // 2. Stock controller fallback
  const fallback = await fetchFromStockController(symbol, authHeader);
  if (fallback?.chart?.length >= MIN_CANDLES) return fallback;

  console.error(`[AI] All fetch strategies exhausted for ${symbol}`);
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

  // Step 1: Normalize whatever the frontend sent
  let chart        = chartFromFrontend ? normalizeCandles(chartFromFrontend) : null;
  let indicators   = indFromFront;
  let currentPrice = cpFromFront;

  // Step 2: Fetch if frontend didn't send enough daily candles
  if (!chart || chart.length < MIN_CANDLES) {
    if (chart?.length) {
      console.log(
        `[AI] ${sym}: frontend sent ${chart.length} candles (need ${MIN_CANDLES}) — fetching daily data`
      );
    }
    const fetched = await fetchChartData(sym, req.headers.authorization);

    if (fetched?.chart?.length >= MIN_CANDLES) {
      chart        = fetched.chart;
      currentPrice = fetched.currentPrice ?? currentPrice;
      indicators   = fetched.indicators   ?? indicators;
      console.log(`[AI] ${sym}: ${chart.length} daily candles ready`);
    } else {
      const available = fetched?.chart?.length ?? chart?.length ?? 0;
      console.error(`[AI] ${sym}: only ${available} valid daily candles available`);
      return res.status(422).json({
        message:
          `Insufficient historical data for ${sym}. ` +
          `Got ${available} daily candles but need at least ${MIN_CANDLES}. ` +
          `This usually means Yahoo Finance returned weekly data. ` +
          `Check that yahoo-finance2 is installed: npm list yahoo-finance2`,
        symbol:    sym,
        available,
        required:  MIN_CANDLES,
      });
    }
  }

  // Step 3: Final guard
  if (!chart || chart.length < MIN_CANDLES) {
    return res.status(422).json({
      message: `chart[] must have at least ${MIN_CANDLES} candles. Got ${chart?.length ?? 0}.`,
      symbol: sym, available: chart?.length ?? 0, required: MIN_CANDLES,
    });
  }

  // Step 4: Shape sanity check
  const first = chart[0];
  const last  = chart[chart.length - 1];
  if (!first?.date || !first?.close || !last?.date || !last?.close) {
    console.error(`[AI] Bad candle shape after normalization:`, { first, last });
    return res.status(422).json({
      message: "Candle data has invalid shape. Each row must have: date (YYYY-MM-DD), open, high, low, close.",
      sample: { first, last },
    });
  }

  // Step 5: Build and send payload to Python
  const payload = {
    symbol: sym, horizon,
    skip_sentiment:   skipSentiment,
    include_chart:    includeChart,
    include_backtest: includeBacktest,
    include_risk:     includeRisk,
    lstm_epochs:      lstmEpochs,
    currency,
    chart,
    current_price:    currentPrice,
    indicators,
  };

  console.log(
    `[AI] → Python: ${chart.length} daily candles for ${sym}` +
    ` | ${first.date} → ${last.date}` +
    ` | close ${first.close} → ${last.close}`
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
            summary: [
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