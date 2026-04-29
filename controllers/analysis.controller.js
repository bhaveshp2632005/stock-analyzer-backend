/**
 * ai.controller.js — Node.js ↔ Python AI Engine bridge v5.1
 * ═══════════════════════════════════════════════════════════
 *
 * v5.1 FIX: Guarantees 200+ candles are always sent to Python.
 *
 * Root cause of 422 errors:
 *   - fetchChartData() used range "2y" which the stock controller doesn't support
 *   - Valid ranges are: "1W" "1M" "3M" "6M" "1Y" "5Y"
 *   - Fallback chain could pass through with < 60 (let alone 200) candles
 *   - No hard validation before calling Python
 *
 * Fixes applied (NO other logic changed):
 *   1. fetchChartData() now tries "5Y" → "1Y" using your stock controller's
 *      valid range values. "5Y" ≈ 1250 trading days, "1Y" ≈ 250 days.
 *   2. MIN_CANDLES = 200 enforced before the Python call.
 *   3. predict() returns HTTP 422 with a clear message if candles < 200,
 *      instead of forwarding a bad request to Python.
 *   4. All other endpoints, caching, error handling, DB persistence — unchanged.
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
// CONSTANTS
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Minimum candles required before calling Python.
 * Python itself requires 60 (hard error) but needs 300+ for best accuracy.
 * We enforce 200 here so the Node layer catches it cleanly.
 */
const MIN_CANDLES = 200;

/**
 * Range priority order to fetch from the stock controller.
 * Your stock controller accepts: "1W" "1M" "3M" "6M" "1Y" "5Y"
 *
 * "5Y"  ≈ 1 250 trading days  ← ideal (2–3 years of trading data)
 * "1Y"  ≈ 252 trading days    ← minimum acceptable
 *
 * We try in descending order and stop at the first response with enough candles.
 */
const FETCH_RANGES = ["5Y", "1Y"];

// ══════════════════════════════════════════════════════════════════════════════
// v5.1 HELPER: Fetch chart data from Node.js stock service
// ══════════════════════════════════════════════════════════════════════════════

/**
 * fetchChartData()
 *
 * Fetches OHLCV candles from the Node.js stock endpoint.
 * Returns { chart, currentPrice, indicators } or null.
 *
 * Strategy:
 *   - Tries each range in FETCH_RANGES ("5Y", "1Y") via the existing
 *     /api/stock/:symbol endpoint that your stock controller exposes.
 *   - Stops at the first response that contains >= MIN_CANDLES candles.
 *   - Falls back to /api/stock/chart/:symbol and /api/stock/:symbol as before.
 *
 * NOTE: Adjust endpoint paths below if your routes differ.
 */
const NODE_BASE = process.env.NODE_INTERNAL_URL || "http://localhost:5000";

const nodeClient = axios.create({
  baseURL: NODE_BASE,
  timeout: 20_000,  // 20s — longer range = more data = slightly slower
});

/**
 * Normalise a raw stock response into a candle array.
 * Your stock controller returns the candles under `payload.chart[]`.
 */
const extractCandles = (data) =>
  Array.isArray(data)
    ? data
    : data?.chart || data?.history || data?.candles || data?.data || [];

async function fetchChartData(symbol, authHeader) {
  const headers = authHeader ? { Authorization: authHeader } : {};

  // ── Strategy 1: /api/stock/:symbol?range=X  (your primary stock route) ─────
  // Try longest range first; fall back to shorter ones.
  for (const range of FETCH_RANGES) {
    try {
      const { data } = await nodeClient.get(
        `/api/stock/${symbol}`,
        { params: { range }, headers }
      );

      const candles = extractCandles(data);

      if (candles.length >= MIN_CANDLES) {
        const last         = candles[candles.length - 1];
        const currentPrice = last?.close ?? last?.price ?? null;
        const indicators   = data?.indicators ?? data?.technicals ?? null;
        console.log(
          `[AI] fetchChartData: ${symbol} — ${candles.length} candles via` +
          ` /api/stock/:symbol?range=${range}`
        );
        return { chart: candles, currentPrice, indicators };
      }

      console.warn(
        `[AI] fetchChartData: ${symbol} range=${range} returned only` +
        ` ${candles.length} candles (need ${MIN_CANDLES}), trying next range…`
      );
    } catch (e) {
      console.warn(
        `[AI] fetchChartData /api/stock/${symbol}?range=${range} failed:`,
        e.message
      );
    }
  }

  // ── Strategy 2: /api/stock/history/:symbol?range=5Y  (dedicated history route) ─
  for (const range of FETCH_RANGES) {
    try {
      const { data } = await nodeClient.get(
        `/api/stock/history/${symbol}`,
        { params: { range, interval: "1d" }, headers }
      );

      const candles = extractCandles(data);

      if (candles.length >= MIN_CANDLES) {
        const last         = candles[candles.length - 1];
        const currentPrice = last?.close ?? last?.price ?? null;
        console.log(
          `[AI] fetchChartData: ${symbol} — ${candles.length} candles via` +
          ` /api/stock/history/:symbol?range=${range}`
        );
        return { chart: candles, currentPrice, indicators: null };
      }
    } catch (e) {
      console.warn(
        `[AI] fetchChartData /api/stock/history/${symbol}?range=${range} failed:`,
        e.message
      );
    }
  }

  // ── Strategy 3: /api/stock/chart/:symbol  (legacy chart endpoint) ──────────
  try {
    const { data } = await nodeClient.get(
      `/api/stock/chart/${symbol}`,
      { headers }
    );
    const candles = extractCandles(data);
    if (candles.length >= MIN_CANDLES) {
      const last         = candles[candles.length - 1];
      const currentPrice = last?.close ?? last?.price ?? null;
      console.log(
        `[AI] fetchChartData: ${symbol} — ${candles.length} candles via /api/stock/chart/:symbol`
      );
      return { chart: candles, currentPrice, indicators: null };
    }
    console.warn(
      `[AI] fetchChartData /api/stock/chart/${symbol} returned only` +
      ` ${candles.length} candles (need ${MIN_CANDLES})`
    );
  } catch (e) {
    console.warn(`[AI] fetchChartData /api/stock/chart/${symbol} failed:`, e.message);
  }

  // All fetches failed or returned too few candles
  console.error(
    `[AI] fetchChartData: could not obtain ${MIN_CANDLES}+ candles for ${symbol}`
  );
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

// ── Full Prediction — v5.1: guaranteed 200+ candles before calling Python ─────
export const predict = async (req, res) => {
  const {
    symbol,
    horizon         = 5,
    skipSentiment   = false,
    includeChart    = false,
    includeBacktest = false,
    includeRisk     = true,
    lstmEpochs      = 60,
    // Caller may pre-supply these; we still validate them below
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

  console.log(`[AI] Predict request: ${sym}, horizon: ${horizon}d`);

  // ── Step 1: Resolve chart data ─────────────────────────────────────────────
  let chart        = chartFromFrontend;
  let indicators   = indFromFront;
  let currentPrice = cpFromFront;

  // Fetch from Node stock service if we don't already have enough candles
  if (!chart || chart.length < MIN_CANDLES) {
    if (chart?.length) {
      console.log(
        `[AI] Frontend sent only ${chart.length} candles for ${sym}` +
        ` (need ${MIN_CANDLES}). Fetching from Node stock service…`
      );
    } else {
      console.log(`[AI] No chart data from frontend for ${sym}. Fetching from Node stock service…`);
    }

    const fetched = await fetchChartData(sym, req.headers.authorization);

    if (fetched?.chart?.length >= MIN_CANDLES) {
      chart        = fetched.chart;
      currentPrice = fetched.currentPrice ?? currentPrice;
      indicators   = fetched.indicators   ?? indicators;
      console.log(`[AI] Using ${chart.length} candles from Node stock service for ${sym}`);
    } else {
      // Hard stop — do NOT call Python with insufficient data
      const available = fetched?.chart?.length ?? chart?.length ?? 0;
      console.error(
        `[AI] Insufficient candle data for ${sym}: ${available} candles` +
        ` (minimum required: ${MIN_CANDLES})`
      );
      return res.status(422).json({
        message:
          `Insufficient historical data for ${sym}. ` +
          `Got ${available} candles but need at least ${MIN_CANDLES} ` +
          `(recommend 300+ for best accuracy). ` +
          `Ensure your stock data provider returns at least 1 year of daily OHLCV data.`,
        symbol:    sym,
        available,
        required:  MIN_CANDLES,
      });
    }
  }

  // ── Step 2: Final candle count guard ──────────────────────────────────────
  // Belt-and-suspenders: re-check even if the frontend sent data
  if (!chart || chart.length < MIN_CANDLES) {
    return res.status(422).json({
      message:
        `chart[] must contain at least ${MIN_CANDLES} candles. ` +
        `Received ${chart?.length ?? 0}. ` +
        `Send 1–3 years of daily OHLCV data for reliable predictions.`,
      symbol:   sym,
      available: chart?.length ?? 0,
      required:  MIN_CANDLES,
    });
  }

  // ── Step 3: Build Python request payload ──────────────────────────────────
  const payload = {
    symbol:           sym,
    horizon,
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
    `[AI] Sending ${chart.length} candles for ${sym}` +
    ` (first: ${chart[0]?.date}, last: ${chart[chart.length - 1]?.date})`
  );

  // ── Step 4: Call Python ───────────────────────────────────────────────────
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