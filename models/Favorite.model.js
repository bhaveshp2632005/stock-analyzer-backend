/**
 * models/Favorite.model.js
 */
import mongoose from "mongoose";

const FavoriteSchema = new mongoose.Schema(
  {
    userId: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      "User",
      required: true,
      index:    true,
    },
    symbol: {
      type:      String,
      required:  true,
      uppercase: true,
      trim:      true,
    },
    alertAbove:      { type: Number, default: null },
    alertBelow:      { type: Number, default: null },
    alertFiredAbove: { type: Boolean, default: false },
    alertFiredBelow: { type: Boolean, default: false },
  },
  { timestamps: true }
);

FavoriteSchema.index({ userId: 1, symbol: 1 }, { unique: true });

export default mongoose.model("Favorite", FavoriteSchema);