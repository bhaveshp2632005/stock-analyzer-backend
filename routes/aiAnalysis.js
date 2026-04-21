import express from "express";
import { runAIPrediction } from "../utils/aiLogic.js";
import { verifyToken }     from "../middleware/auth.middleware.js";

const router = express.Router();

// Protected — only logged-in users can run AI analysis
router.post("/analyze", verifyToken, async (req, res) => {
  try {
    const { indicators, price, prevClose, chart } = req.body;

    // Basic input validation
    if (!indicators || price == null)
      return res.status(400).json({ error: "Missing required fields: indicators, price" });

    const result = await runAIPrediction({ indicators, price, prevClose, chart });
    res.json(result);
  } catch (err) {
    console.error("AI Error:", err.message);
    res.status(500).json({ error: "AI prediction failed" });
  }
});

export default router;