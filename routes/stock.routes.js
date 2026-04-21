/**
 * stock.routes.js — Secured
 *
 * Security layers:
 *  1. Input sanitization — symbol stripped of dangerous chars
 *  2. Input validation   — symbol format enforced, length capped
 *  3. Batch validation   — array size capped, each symbol sanitized
 *  4. Auth enforcement   — verifyToken on all data routes
 *  5. No-cache headers   — prevents stale data from proxies
 */

import express from "express";
import {
  getStockData,
  getBatchStockData,
  getProviderHealth,
} from "../controllers/stock.controller.js";
import { verifyToken } from "../middleware/auth.middleware.js";

const router = express.Router();

/* ════════════════════════════════════════════════════════════
   SANITIZATION + VALIDATION MIDDLEWARE
════════════════════════════════════════════════════════════ */

const SYMBOL_RE    = /^[A-Z0-9.\-]{1,20}$/;
const VALID_RANGES = new Set(["1W", "1M", "3M", "6M", "1Y", "5Y"]);

const sanitizeSymbol = (req, res, next) => {
  const cleaned = (req.params.symbol || "").trim().toUpperCase().replace(/[^A-Z0-9.\-]/g, "");

  if (!cleaned)          return res.status(400).json({ error: "Stock symbol is required." });
  if (cleaned.length > 20) return res.status(400).json({ error: "Symbol too long. Maximum 20 characters." });
  if (!SYMBOL_RE.test(cleaned)) return res.status(400).json({ error: "Invalid symbol format. Only letters, numbers, dots, and hyphens are allowed." });

  req.params.symbol = cleaned;
  next();
};

const validateRange = (req, res, next) => {
  const range = (req.query.range || "1M").toUpperCase();
  if (!VALID_RANGES.has(range)) {
    return res.status(400).json({ error: `Invalid range "${req.query.range}". Allowed: 1W 1M 3M 6M 1Y 5Y` });
  }
  req.query.range = range;
  next();
};

const validateBatchBody = (req, res, next) => {
  const { symbols, range } = req.body;

  if (!Array.isArray(symbols))  return res.status(400).json({ error: "Request body must include a 'symbols' array." });
  if (symbols.length === 0)     return res.status(400).json({ error: "'symbols' array cannot be empty." });
  if (symbols.length > 20)      return res.status(400).json({ error: "Maximum 20 symbols allowed per batch request." });

  const cleaned = [];
  for (const raw of symbols) {
    if (typeof raw !== "string") return res.status(400).json({ error: "Each symbol must be a string." });
    const sym = raw.trim().toUpperCase().replace(/[^A-Z0-9.\-]/g, "");
    if (!sym || sym.length > 20 || !SYMBOL_RE.test(sym)) {
      return res.status(400).json({ error: `Invalid symbol: "${raw}". Only letters, numbers, dots, and hyphens allowed (max 20 chars).` });
    }
    cleaned.push(sym);
  }

  if (range !== undefined) {
    const r = String(range).toUpperCase();
    if (!VALID_RANGES.has(r)) return res.status(400).json({ error: `Invalid range "${range}". Allowed: 1W 1M 3M 6M 1Y 5Y` });
    req.body.range = r;
  }

  req.body.symbols = cleaned;
  next();
};

const noCache = (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma",        "no-cache");
  res.setHeader("Expires",       "0");
  next();
};

/* ════════════════════════════════════════════════════════════
   ROUTES
════════════════════════════════════════════════════════════ */

router.get("/health",  noCache, getProviderHealth);
router.post("/batch",  verifyToken, noCache, validateBatchBody, getBatchStockData);
router.get("/:symbol", verifyToken, noCache, sanitizeSymbol, validateRange, getStockData);

export default router;