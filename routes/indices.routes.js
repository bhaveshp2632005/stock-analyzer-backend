/**
 * indices.routes.js
 * GET /api/indices/:symbol
 *
 * FIX: Express does not decode %5E → ^ automatically in route params.
 *      We handle it in the controller via decodeURIComponent.
 *      The wildcard param :symbol(*) ensures ^ and % chars are captured.
 */

import express          from "express";
import { verifyToken }  from "../middleware/auth.middleware.js";
import { getIndexData } from "../controllers/indices.controller.js";

const router = express.Router();


router.get("/:symbol", verifyToken, getIndexData);

export default router;