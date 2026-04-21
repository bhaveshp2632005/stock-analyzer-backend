/**
 * movers.routes.js
 * GET /api/movers  →  getTopMovers
 */

import express          from "express";
import { getTopMovers } from "../controllers/movers.controller.js";
import { verifyToken }  from "../middleware/auth.middleware.js";

const router = express.Router();

router.get("/", verifyToken, getTopMovers);

export default router;