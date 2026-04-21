/**
 * ai.controller.js — Node.js ↔ Python AI Engine bridge (v3.0)
 * ═══════════════════════════════════════════════════════════════
 *
 * Routes (all mounted at /api/ai in server.js):
 *   POST /api/ai/analyze          → quick signal (Python /analyze)
 *   POST /api/ai/predict          → full LSTM+XGB prediction
 *   GET  /api/ai/regime/:symbol   → market regime
 *   GET  /api/ai/sentiment/:symbol
 *   POST /api/ai/portfolio        → MPT optimizer
 *   GET  /api/ai/risk/:symbol
 *   POST /api/ai/backtest
 *   GET  /api/ai/indicators/:symbol
 *   GET  /api/ai/chart/:symbol
 *   GET  /api/ai/timeframes/:symbol
 *   GET  /api/ai/macro
 *   POST /api/ai/rl/train
 *   GET  /api/ai/rl/evaluate/:symbol
 *   GET  /api/ai/health
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

// ── In-memory TTL cache (Node side — avoids double-fetching) ─────────────────
const _cache    = new Map();
const CACHE_TTL = Number(process.env.AI_CACHE_TTL_MS) || 900_000; // 15 min

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
// CONTROLLERS
// ══════════════════════════════════════════════════════════════════════════════

// ── Quick AI Signal (used by Analyze.jsx "Quick AI Signal" button) ────────────
export const analyzeQuick = async (req, res) => {
  try {
    const { data } = await aiClient.post("/analyze", req.body);
    return res.json(data);
  } catch (err) {
    // Soft failure — return neutral HOLD so UI doesn't break
    if (err.code === "ECONNREFUSED")
      return res.json({ action: "HOLD", confidence: 30,
                        summary: "AI Engine offline — showing neutral signal", score: 0 });
    return handleErr(res, err, "QuickAnalyze");
  }
};

// ── Full Prediction (LSTM + XGBoost + FinBERT) ────────────────────────────────
export const predict = async (req, res) => {
  const {
    symbol,
    horizon          = 5,
    skipSentiment    = false,
    includeChart     = false,
    includeBacktest  = false,
    includeRisk      = true,
    lstmEpochs       = 60,
  } = req.body;
 console.log(`[AI] Predict request: ${symbol}, horizon: ${horizon}d, skipSentiment: ${skipSentiment}, includeChart: ${includeChart}, includeBacktest: ${includeBacktest}, includeRisk: ${includeRisk}, lstmEpochs: ${lstmEpochs}`);
  if (!symbol) return res.status(400).json({ message: "symbol required" });
  const sym = symbol.toUpperCase().trim();
  const ck  = `predict:${sym}:${horizon}`;
  const cached = cget(ck);
  if (cached) return res.json({ ...cached, fromCache: true });

  try {
    const { data } = await aiClient.post("/predict", {
      symbol:           sym,
      horizon,
      skip_sentiment:   skipSentiment,
      include_chart:    includeChart,
      include_backtest: includeBacktest,
      include_risk:     includeRisk,
      lstm_epochs:      lstmEpochs,
    });

    // Persist to MongoDB (non-blocking)
    if (req.user?.id) {
      Analysis.findOneAndUpdate(
        { userId: req.user.id, symbol: sym },
        {
          $set: {
            price:      String(data.currentPrice ?? ""),
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
  const { symbol, initialCash = 100000, signalThreshold = 1.5 } = req.body;
  if (!symbol) return res.status(400).json({ message: "symbol required" });
  try {
    const { data } = await aiClient.post("/backtest", {
      symbol:           symbol.toUpperCase(),
      initial_cash:     initialCash,
      signal_threshold: signalThreshold,
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