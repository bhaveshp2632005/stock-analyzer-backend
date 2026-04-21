/**
 * routes/news.routes.js
 *
 * POST /api/news/fetch/:symbol  — force-fetch from external API
 * GET  /api/news/:symbol        — return stored news (auto-refreshes if stale)
 */

import express            from "express";
import { getNews, fetchNews } from "../controllers/news.controller.js";
import { verifyToken }    from "../middleware/auth.middleware.js";

const router = express.Router();

// POST must be before GET /:symbol to avoid Express treating "fetch" as a symbol param
router.post("/fetch/:symbol", verifyToken, fetchNews);
router.get("/:symbol",        verifyToken, getNews);

export default router;