import express from "express";
import { verifyToken } from "../middleware/auth.middleware.js";
import { getIndexData } from "../controllers/indices.controller.js";

const router = express.Router();

router.get("/:symbol", verifyToken, getIndexData);

export default router;