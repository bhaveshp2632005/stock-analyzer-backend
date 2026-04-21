import express from "express";
import {
  saveAnalysis,
  getHistory,
  deleteAnalysis,
  clearHistory,
} from "../controllers/analysis.controller.js";
import { verifyToken } from "../middleware/auth.middleware.js";

const router = express.Router();

// All routes require valid JWT
router.post  ("/",    verifyToken, saveAnalysis);   // POST   /api/analysis
router.get   ("/",    verifyToken, getHistory);     // GET    /api/analysis

// ⚠️  ORDER MATTERS — "/:id" must come AFTER explicit paths
// DELETE "/" must be registered before DELETE "/:id"
// otherwise Express never reaches clearHistory (":id" matches "" too)
router.delete("/all", verifyToken, clearHistory);   // DELETE /api/analysis/all
router.delete("/:id", verifyToken, deleteAnalysis); // DELETE /api/analysis/:id

export default router;