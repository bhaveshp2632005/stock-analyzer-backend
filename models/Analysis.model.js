import mongoose from "mongoose";

const AnalysisSchema = new mongoose.Schema(
  {
    userId:     { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    symbol:     { type: String, required: true, uppercase: true, trim: true },
    price:      { type: String },
    signal:     { type: String, enum: ["BUY", "SELL", "HOLD"] },
    confidence: { type: Number, min: 0, max: 100 },
    summary:    { type: String, maxlength: 1000 },
    date:       { type: String },
  },
  { timestamps: true }
);

// Compound index — fast queries per user, unique per user+symbol
AnalysisSchema.index({ userId: 1, symbol: 1 }, { unique: true });
AnalysisSchema.index({ userId: 1, updatedAt: -1 });

export default mongoose.model("Analysis", AnalysisSchema);