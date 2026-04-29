/**
 * ai.controller.js — Node.js ↔ Python AI Engine bridge v5.0
 * ═══════════════════════════════════════════════════════════
 *
 * v5.0 CHANGE: predict() now fetches OHLCV data from Node.js stock service
 * and sends it to Python. Python no longer calls data_loader.py.
 *
 * Flow:
 *   Frontend → Node /api/ai/predict
 *     → fetchChartData() gets candles from Node stock service
 *     → Python /predict receives { symbol, chart[], indicators{}, currentPrice }
 *     → Python predicts using provided data (no external API calls)
 *     → Response forwarded to frontend
 *
 * All other endpoints (regime, sentiment, risk, etc.) unchanged.
 */
import axios    from "axios";
import Analysis from "../models/Analysis.model.js";

const AI_BASE    = process.env.AI_ENGINE_URL || "http://localhost:8000";
const AI_TIMEOUT = Number(process.env.AI_TIMEOUT_MS) || 300_000;  // 5 min

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
// v5.0 HELPER: Fetch chart data from Node.js stock service
// ══════════════════════════════════════════════════════════════════════════════

/**
 * fetchChartData()
 *
 * Gets OHLCV candles from the Node.js stock endpoint that already exists.
 * Returns { chart, currentPrice, indicators } to send to Python.
 *
 * Tries multiple internal endpoints in order:
 *   1. /api/stock/history/:symbol?range=2y  ← preferred (most data)
 *   2. /api/stock/chart/:symbol             ← fallback
 *   3. /api/stock/:symbol                   ← minimal fallback
 *
 * IMPORTANT: Adjust the endpoint URLs below to match YOUR Node.js stock routes.
 */
const NODE_BASE = process.env.NODE_INTERNAL_URL || "http://localhost:5000";

const nodeClient = axios.create({
  baseURL: NODE_BASE,
  timeout: 15_000,  // 15s for data fetch
});

async function fetchChartData(symbol, authHeader) {
  const headers = authHeader ? { Authorization: authHeader } : {};

  // Try endpoint 1: history with 2-year range (sends most candles)
  try {
    const { data } = await nodeClient.get(
      `/api/stock/history/${symbol}`,
      { params: { range: "2y", interval: "1d" }, headers }
    );

    // Normalise response — your stock route may return different shapes
    const candles = Array.isArray(data)
      ? data
      : data?.chart || data?.history || data?.candles || data?.data || [];

    if (candles.length >= 60) {
      const last         = candles[candles.length - 1];
      const currentPrice = last?.close || last?.price || null;
      return { chart: candles, currentPrice };
    }
  } catch (e) {
    console.warn(`[AI] fetchChartData endpoint1 failed for ${symbol}:`, e.message);
  }

  // Try endpoint 2: chart endpoint
  try {
    const { data } = await nodeClient.get(
      `/api/stock/chart/${symbol}`,
      { headers }
    );
    const candles = Array.isArray(data)
      ? data
      : data?.chart || data?.candles || data?.data || [];

    if (candles.length >= 60) {
      const last         = candles[candles.length - 1];
      const currentPrice = last?.close || last?.price || null;
      return { chart: candles, currentPrice };
    }
  } catch (e) {
    console.warn(`[AI] fetchChartData endpoint2 failed for ${symbol}:`, e.message);
  }

  // Try endpoint 3: basic stock quote (may only have indicators, not full history)
  try {
    const { data } = await nodeClient.get(`/api/stock/${symbol}`, { headers });
    const candles = data?.history || data?.chart || data?.candles || [];

    if (candles.length >= 60) {
      return {
        chart:        candles,
        currentPrice: data?.price || data?.currentPrice || null,
        indicators:   data?.indicators || data?.technicals || null,
      };
    }
  } catch (e) {
    console.warn(`[AI] fetchChartData endpoint3 failed for ${symbol}:`, e.message);
  }

  // All internal fetches failed — Python will fallback to data_loader
  return null;
}

// ══════════════════════════════════════════════════════════════════════════════
// CONTROLLERS
// ══════════════════════════════════════════════════════════════════════════════

// ── Quick AI Signal ───────────────────────────────────────────────────────────
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

// ── Full Prediction — v5.0: sends chart data to Python ───────────────────────
export const predict = async (req, res) => {
  const {
    symbol,
    horizon         = 5,
    skipSentiment   = false,
    includeChart    = false,
    includeBacktest = false,
    includeRisk     = true,
    lstmEpochs      = 60,
    // Node.js may already have these from its own data fetch:
    chart: chartFromFrontend  = null,
    indicators: indFromFront  = null,
    currentPrice: cpFromFront = null,
    currency                  = "USD",
  } = req.body;

  console.log(`[AI] Predict request: ${symbol}, horizon: ${horizon}d`);
  if (!symbol) return res.status(400).json({ message: "symbol required" });

  const sym = symbol.toUpperCase().trim();
  const ck  = `predict:${sym}:${horizon}`;
  const cached = cget(ck);
  if (cached) return res.json({ ...cached, fromCache: true });

  // ── Step 1: Get chart data ─────────────────────────────────────────────────
  // Priority: frontend sent it → fetch from Node stock service → let Python fetch
  let chart      = chartFromFrontend;
  let indicators = indFromFront;
  let currentPrice = cpFromFront;

  if (!chart || chart.length < 60) {
    console.log(`[AI] Fetching chart data for ${sym} from Node stock service…`);
    const fetched = await fetchChartData(sym, req.headers.authorization);
    if (fetched?.chart?.length >= 60) {
      chart        = fetched.chart;
      currentPrice = fetched.currentPrice || currentPrice;
      indicators   = fetched.indicators   || indicators;
      console.log(`[AI] Got ${chart.length} candles from Node stock service`);
    } else {
      // Python will use its own data_loader as last resort
      console.warn(`[AI] Could not get chart data from Node — Python will fetch itself`);
    }
  }

  // ── Step 2: Build Python request payload ──────────────────────────────────
  const payload = {
    symbol:          sym,
    horizon,
    skip_sentiment:  skipSentiment,
    include_chart:   includeChart,
    include_backtest: includeBacktest,
    include_risk:    includeRisk,
    lstm_epochs:     lstmEpochs,
    currency,
  };

  // Add pre-fetched data if available
  if (chart && chart.length >= 60) {
    payload.chart         = chart;
    payload.current_price = currentPrice;
    payload.indicators    = indicators;
  }

  // ── Step 3: Call Python ───────────────────────────────────────────────────
  try {
    const { data } = await aiClient.post("/predict", payload);

    // Persist to MongoDB (non-blocking)
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

// ── Regime ────────────────────────────────────────────────────────────────────
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

// ── Sentiment ─────────────────────────────────────────────────────────────────
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

// ── Portfolio Optimize ────────────────────────────────────────────────────────
export const portfolioOptimize = async (req, res) => {
  const { symbols, method = "max_sharpe", regime: reg = "Sideways" } = req.body;
  if (!symbols?.length) return res.status(400).json({ message: "symbols required" });
  try {
    const { data } = await aiClient.post("/portfolio", {
      symbols: symbols.map((s) => s.toUpperCase()),
      method,
      regime: reg,
    });
    return res.json(data);
  } catch (err) { return handleErr(res, err, "Portfolio"); }
};

// ── Risk ──────────────────────────────────────────────────────────────────────
export const risk = async (req, res) => {
  const sym = req.params.symbol.toUpperCase().trim();
  try {
    const { data } = await aiClient.get(`/risk/${sym}`);
    return res.json(data);
  } catch (err) { return handleErr(res, err, "Risk"); }
};

// ── Backtest ──────────────────────────────────────────────────────────────────
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

// ── Indicators ────────────────────────────────────────────────────────────────
export const indicators = async (req, res) => {
  const sym = req.params.symbol.toUpperCase().trim();
  try {
    const { data } = await aiClient.get(`/indicators/${sym}`, {
      params: { n_days: Number(req.query.n) || 30 },
    });
    return res.json(data);
  } catch (err) { return handleErr(res, err, "Indicators"); }
};

// ── Chart ─────────────────────────────────────────────────────────────────────
export const chart = async (req, res) => {
  const sym = req.params.symbol.toUpperCase().trim();
  try {
    const { data } = await aiClient.get(`/chart/${sym}`, {
      params: { chart_type: req.query.type || "price" },
    });
    return res.json(data);
  } catch (err) { return handleErr(res, err, "Chart"); }
};

// ── Timeframes ────────────────────────────────────────────────────────────────
export const timeframes = async (req, res) => {
  const sym = req.params.symbol.toUpperCase().trim();
  try {
    const { data } = await aiClient.get(`/timeframes/${sym}`);
    return res.json(data);
  } catch (err) { return handleErr(res, err, "Timeframes"); }
};

// ── Macro ─────────────────────────────────────────────────────────────────────
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

// ── RL Train ──────────────────────────────────────────────────────────────────
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

// ── RL Evaluate ───────────────────────────────────────────────────────────────
export const rlEvaluate = async (req, res) => {
  const sym = req.params.symbol.toUpperCase().trim();
  try {
    const { data } = await aiClient.get(`/rl/evaluate/${sym}`, {
      params: { algorithm: req.query.algorithm || "PPO" },
    });
    return res.json(data);
  } catch (err) { return handleErr(res, err, "RLEvaluate"); }
};

// ── Health ────────────────────────────────────────────────────────────────────
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