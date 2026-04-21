/**
 * ai.routes.js — AI Trading Platform routes (v3.0)
 * Mount in server.js: app.use("/api/ai", aiRoutes)
 *
 * FIXES:
 *   • verifyToken → protect  (correct auth.middleware.js export)
 *   • /analyze endpoint added (Quick AI Signal from Analyze.jsx)
 *   • /portfolio, /macro, /rl/* routes added
 */
import express from "express";
import { protect } from "../middleware/auth.middleware.js";
import {
  analyzeQuick,
  predict,
  regime,
  sentiment,
  portfolioOptimize,
  risk,
  backtest,
  indicators,
  chart,
  timeframes,
  macro,
  rlTrain,
  rlEvaluate,
  health,
} from "../controllers/ai.controller.js";

const router = express.Router();

// ── Public ────────────────────────────────────────────────────────────────────
router.get("/health", health);

// ── Protected (JWT required) ──────────────────────────────────────────────────

// Quick signal — used by Analyze.jsx "Quick AI Signal" button
router.post("/analyze",              protect, analyzeQuick);

// Full prediction engine
router.post("/predict",              protect, predict);

// Regime / sentiment
router.get ("/regime/:symbol",       protect, regime);
router.get ("/sentiment/:symbol",    protect, sentiment);

// Portfolio + risk
router.post("/portfolio",            protect, portfolioOptimize);
// Legacy compat: /portfolio/optimize → same handler
router.post("/portfolio/optimize",   protect, portfolioOptimize);
router.get ("/risk/:symbol",         protect, risk);

// Backtest + indicators + chart
router.post("/backtest",             protect, backtest);
router.get ("/indicators/:symbol",   protect, indicators);
router.get ("/chart/:symbol",        protect, chart);
router.get ("/timeframes/:symbol",   protect, timeframes);

// Macro snapshot
router.get ("/macro",                protect, macro);

// Reinforcement learning
router.post("/rl/train",             protect, rlTrain);
router.get ("/rl/evaluate/:symbol",  protect, rlEvaluate);

export default router;