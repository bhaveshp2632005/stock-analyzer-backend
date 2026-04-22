/**
 * routes/favorites.routes.js
 *
 * Register in server.js:
 *   import favoritesRoutes from "./routes/favorites.routes.js";
 *   app.use("/api/favorites", apiLimiter, favoritesRoutes);
 *
 * NOTE: /prices and /check-alerts must be declared BEFORE /:symbol
 * so Express doesn't treat "prices" as a symbol param.
 */

import { Router }       from "express";
import { protect }      from "../middleware/auth.middleware.js";
import {
  getAll, add, updateAlert, remove, getPrices, checkAlerts,
} from "../controllers/favorites.controller.js";

const router = Router();

router.use(protect);   // all routes require valid JWT

// ── specific paths first ────────────────────────────────
router.get   ("/prices",        getPrices);     // GET    /api/favorites/prices
router.post  ("/check-alerts",  checkAlerts);   // POST   /api/favorites/check-alerts

// ── CRUD ────────────────────────────────────────────────
router.get   ("/",              getAll);         // GET    /api/favorites
router.post  ("/",              add);            // POST   /api/favorites
router.put   ("/:symbol",       updateAlert);    // PUT    /api/favorites/AAPL
router.delete("/:symbol",       remove);         // DELETE /api/favorites/AAPL

export default router;
