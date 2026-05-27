/**
 * ai.controller.js — Node.js ↔ Python AI Engine bridge (v3.1)
 * ═══════════════════════════════════════════════════════════════
 *
 * FIXES in v3.1:
 *  1. Index symbol support — ^NSEI, ^BSESN, ^NSEBANK passed correctly to Python
 *  2. Better 500 error logging with full stack traces
 *  3. Request body validation before forwarding to Python
 *  4. Timeout increased to 10 min for index predictions (more data to load)
 *  5. Cache key normalisation — ^NSEI and %5ENSEI map to same key
 *  6. Graceful degradation — returns partial result on non-critical failures
 */

import axios    from "axios";
import Analysis from "../models/Analysis.model.js";

const AI_BASE    = process.env.AI_ENGINE_URL || "http://localhost:8000";
const AI_TIMEOUT = Number(process.env.AI_TIMEOUT_MS) || 600_000; // 10 min

const aiClient = axios.create({
  baseURL: AI_BASE,
  timeout: AI_TIMEOUT,
  headers: { "Content-Type": "application/json" },
});

/* ── In-memory TTL cache ── */
const _cache    = new Map();
const CACHE_TTL = Number(process.env.AI_CACHE_TTL_MS) || 900_000; // 15 min

const cget = (k) => {
  const e = _cache.get(k);
  if (!e) return null;
  if (Date.now() - e.ts > CACHE_TTL) { _cache.delete(k); return null; }
  return e.data;
};
const cset = (k, d) => _cache.set(k, { data: d, ts: Date.now() });

/* ── Normalise symbol for cache key (^NSEI, %5ENSEI → nsei_idx) ── */
const normCacheKey = (sym) =>
  decodeURIComponent(sym || "")
    .toUpperCase()
    .replace(/[^A-Z0-9.]/g, "_");

/* ── Determine if symbol is an index ── */
const isIndex = (sym) => /^\^/.test(sym) || /^(NIFTY|SENSEX|BANKNIFTY)/i.test(sym);

/* ── Error handler ── */
const handleErr = (res, err, ctx) => {
  const status = err.response?.status;

  if (err.code === "ECONNREFUSED") {
    return res.status(503).json({
      message: "AI Engine offline. Start with: uvicorn main:app --port 8000",
      ctx,
    });
  }
  if (err.code === "ECONNABORTED" || err.code === "ETIMEDOUT") {
    return res.status(504).json({ message: "AI Engine timed out", ctx });
  }
  if (status === 422) {
    return res.status(422).json({
      message: err.response.data?.detail || "Invalid input",
      ctx,
    });
  }
  if (status === 404) {
    return res.status(404).json({ message: `AI endpoint not found: ${ctx}`, ctx });
  }

  // Log full error for debugging
  console.error(`[AI] ${ctx} ERROR:`, {
    message:  err.message,
    code:     err.code,
    status:   status,
    response: err.response?.data,
  });

  return res.status(500).json({
    message: `${ctx} failed: ${err.message}`,
    ctx,
  });
};

/* ── Validate predict request body ── */
const validatePredictBody = (body) => {
  const errors = [];
  if (!body.symbol || typeof body.symbol !== "string") {
    errors.push("symbol is required and must be a string");
  }
  const horizon = Number(body.horizon);
  if (isNaN(horizon) || horizon < 1 || horizon > 30) {
    errors.push("horizon must be a number between 1 and 30");
  }
  return errors;
};

/* ══════════════════════════════════════════════════════════════════════════════
   CONTROLLERS
══════════════════════════════════════════════════════════════════════════════ */

/* ── Quick AI Signal ── */
export const analyzeQuick = async (req, res) => {
  try {
    const { data } = await aiClient.post("/analyze", req.body);
    return res.json(data);
  } catch (err) {
    if (err.code === "ECONNREFUSED") {
      return res.json({
        action:     "HOLD",
        confidence: 30,
        summary:    "AI Engine offline — showing neutral signal",
        score:      0,
      });
    }
    return handleErr(res, err, "QuickAnalyze");
  }
};

/* ── Full Prediction ── */
export const predict = async (req, res) => {
  // Validate request body
  const validationErrors = validatePredictBody(req.body);
  if (validationErrors.length > 0) {
    return res.status(400).json({ message: validationErrors.join("; ") });
  }

  const {
    symbol,
    horizon         = 5,
    skipSentiment   = false,
    includeChart    = false,
    includeBacktest = false,
    includeRisk     = true,
    lstmEpochs      = 60,
  } = req.body;

  const sym = decodeURIComponent(symbol).toUpperCase().trim();
  const ck  = `predict:${normCacheKey(sym)}:${horizon}`;

  console.log(`[AI] Predict: symbol="${sym}" horizon=${horizon}d isIndex=${isIndex(sym)}`);

  const cached = cget(ck);
  if (cached) return res.json({ ...cached, fromCache: true });

  try {
    const { data } = await aiClient.post("/predict", {
      symbol:           sym,
      horizon:          Number(horizon),
      skip_sentiment:   Boolean(skipSentiment),
      include_chart:    Boolean(includeChart),
      include_backtest: Boolean(includeBacktest),
      include_risk:     Boolean(includeRisk),
      lstm_epochs:      Number(lstmEpochs),
    });

    // Persist to MongoDB (non-blocking, don't fail on DB error)
    if (req.user?.id && data) {
      Analysis.findOneAndUpdate(
        { userId: req.user.id, symbol: sym },
        {
          $set: {
            price:      String(data.currentPrice ?? ""),
            signal:     data.trend === "Bullish" ? "BUY"
                      : data.trend === "Bearish" ? "SELL" : "HOLD",
            confidence: data.confidence ?? 0,
            summary: [
              `${data.trend} +${Number(data.predictedReturn || 0).toFixed(2)}%`,
              `Regime: ${data.marketRegime?.currentRegime ?? "N/A"}`,
              `Sentiment: ${data.sentiment?.label ?? "N/A"}`,
            ].join(" | "),
            date: new Date().toISOString().split("T")[0],
          },
        },
        { upsert: true, new: true }
      ).catch(dbErr => console.warn("[AI] DB persist failed:", dbErr.message));
    }

    cset(ck, data);
    return res.json({ ...data, fromCache: false });

  } catch (err) {
    return handleErr(res, err, "Predict");
  }
};

/* ── Regime ── */
export const regime = async (req, res) => {
  const sym = decodeURIComponent(req.params.symbol).toUpperCase().trim();
  const ck  = `regime:${normCacheKey(sym)}`;
  const cached = cget(ck);
  if (cached) return res.json({ ...cached, fromCache: true });
  try {
    const { data } = await aiClient.get(`/regime/${encodeURIComponent(sym)}`);
    cset(ck, data);
    return res.json({ ...data, fromCache: false });
  } catch (err) { return handleErr(res, err, "Regime"); }
};

/* ── Sentiment ── */
export const sentiment = async (req, res) => {
  const sym = decodeURIComponent(req.params.symbol).toUpperCase().trim();
  const ck  = `sent:${normCacheKey(sym)}`;
  const cached = cget(ck);
  if (cached) return res.json({ ...cached, fromCache: true });
  try {
    const { data } = await aiClient.get(`/sentiment/${encodeURIComponent(sym)}`);
    cset(ck, data);
    return res.json({ ...data, fromCache: false });
  } catch (err) { return handleErr(res, err, "Sentiment"); }
};

/* ── Portfolio Optimize ── */
export const portfolioOptimize = async (req, res) => {
  const { symbols, method = "max_sharpe", regime: reg = "Sideways" } = req.body;
  if (!symbols?.length) {
    return res.status(400).json({ message: "symbols array is required" });
  }
  try {
    const { data } = await aiClient.post("/portfolio", {
      symbols: symbols.map(s => decodeURIComponent(s).toUpperCase()),
      method,
      regime: reg,
    });
    return res.json(data);
  } catch (err) { return handleErr(res, err, "Portfolio"); }
};

/* ── Risk ── */
export const risk = async (req, res) => {
  const sym = decodeURIComponent(req.params.symbol).toUpperCase().trim();
  try {
    const { data } = await aiClient.get(`/risk/${encodeURIComponent(sym)}`);
    return res.json(data);
  } catch (err) { return handleErr(res, err, "Risk"); }
};

/* ── Backtest ── */
export const backtest = async (req, res) => {
  const { symbol, initialCash = 100000, signalThreshold = 0.8 } = req.body;
  if (!symbol) return res.status(400).json({ message: "symbol is required" });
  const sym = decodeURIComponent(symbol).toUpperCase().trim();
  console.log(`[AI] Backtest: symbol="${sym}"`);
  try {
    const { data } = await aiClient.post("/backtest", {
      symbol:           sym,
      initial_cash:     Number(initialCash),
      signal_threshold: Number(signalThreshold),
    });
    return res.json(data);
  } catch (err) { return handleErr(res, err, "Backtest"); }
};

/* ── Indicators ── */
export const indicators = async (req, res) => {
  const sym = decodeURIComponent(req.params.symbol).toUpperCase().trim();
  try {
    const { data } = await aiClient.get(`/indicators/${encodeURIComponent(sym)}`, {
      params: { n_days: Number(req.query.n) || 30 },
    });
    return res.json(data);
  } catch (err) { return handleErr(res, err, "Indicators"); }
};

/* ── Chart ── */
export const chart = async (req, res) => {
  const sym = decodeURIComponent(req.params.symbol).toUpperCase().trim();
  try {
    const { data } = await aiClient.get(`/chart/${encodeURIComponent(sym)}`, {
      params: { chart_type: req.query.type || "price" },
    });
    return res.json(data);
  } catch (err) { return handleErr(res, err, "Chart"); }
};

/* ── Timeframes ── */
export const timeframes = async (req, res) => {
  const sym = decodeURIComponent(req.params.symbol).toUpperCase().trim();
  try {
    const { data } = await aiClient.get(`/timeframes/${encodeURIComponent(sym)}`);
    return res.json(data);
  } catch (err) { return handleErr(res, err, "Timeframes"); }
};

/* ── Macro ── */
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

/* ── RL Train ── */
export const rlTrain = async (req, res) => {
  const { symbol, algorithm = "PPO", totalTimesteps = 30000 } = req.body;
  if (!symbol) return res.status(400).json({ message: "symbol is required" });
  try {
    const { data } = await aiClient.post("/rl/train", {
      symbol:          decodeURIComponent(symbol).toUpperCase(),
      algorithm,
      total_timesteps: Number(totalTimesteps),
    });
    return res.json(data);
  } catch (err) { return handleErr(res, err, "RLTrain"); }
};

/* ── RL Evaluate ── */
export const rlEvaluate = async (req, res) => {
  const sym = decodeURIComponent(req.params.symbol).toUpperCase().trim();
  try {
    const { data } = await aiClient.get(`/rl/evaluate/${encodeURIComponent(sym)}`, {
      params: { algorithm: req.query.algorithm || "PPO" },
    });
    return res.json(data);
  } catch (err) { return handleErr(res, err, "RLEvaluate"); }
};

/* ── Health ── */
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