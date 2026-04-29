import Analysis from "../models/Analysis.model.js";

export const saveAnalysis = async (req, res) => {
  try {
    const { symbol, price, signal, confidence, summary } = req.body;
    const userId = req.user.id;
    if (!symbol || !signal) return res.status(400).json({ error: "symbol and signal required" });
    const validSignals = ["BUY", "SELL", "HOLD"];
    if (!validSignals.includes(signal)) return res.status(400).json({ error: "Invalid signal" });
    const analysis = await Analysis.findOneAndUpdate(
      { userId, symbol: symbol.toUpperCase() },
      { userId, symbol: symbol.toUpperCase(), price, signal,
        confidence: Number(confidence) || 0,
        summary: summary?.slice(0, 1000) || "",
        date: new Date().toLocaleDateString("en-IN", { day:"2-digit", month:"short", year:"numeric" }),
      },
      { upsert: true, new: true, runValidators: true }
    );
    res.json({ success: true, analysis });
  } catch (err) {
    console.error("Save analysis error:", err.message);
    res.status(500).json({ error: "Failed to save analysis" });
  }
};

export const getHistory = async (req, res) => {
  try {
    const history = await Analysis.find({ userId: req.user.id }).sort({ updatedAt: -1 }).lean();
    res.json(history);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch history" });
  }
};

export const deleteAnalysis = async (req, res) => {
  try {
    const deleted = await Analysis.findOneAndDelete({ _id: req.params.id, userId: req.user.id });
    if (!deleted) return res.status(404).json({ error: "Analysis not found" });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete" });
  }
};

export const clearHistory = async (req, res) => {
  try {
    const result = await Analysis.deleteMany({ userId: req.user.id });
    res.json({ success: true, deleted: result.deletedCount });
  } catch (err) {
    res.status(500).json({ error: "Failed to clear history" });
  }
};