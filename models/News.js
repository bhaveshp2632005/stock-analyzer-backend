/**
 * models/News.js
 * MongoDB schema for stock news articles
 */

import mongoose from "mongoose";

const newsSchema = new mongoose.Schema(
  {
    symbol: {
      type:      String,
      required:  true,
      uppercase: true,
      index:     true,
    },
    headline: {
      type:     String,
      required: true,
      trim:     true,
    },
    description: {
      type:    String,
      default: "",
      trim:    true,
    },
    source: {
      type:    String,
      default: "Unknown",
      trim:    true,
    },
    url: {
      type:     String,
      required: true,
      trim:     true,
      unique:   true,          // primary duplicate guard
    },
    imageUrl: {
      type:    String,
      default: "",
    },
    publishedAt: {
      type:    Date,
      default: Date.now,
    },
  },
  { timestamps: true }         // adds createdAt + updatedAt automatically
);

// Fast lookup: latest news per symbol
newsSchema.index({ symbol: 1, publishedAt: -1 });

// Secondary duplicate guard: same headline for same symbol
newsSchema.index({ symbol: 1, headline: 1 }, { unique: true });

export default mongoose.model("News", newsSchema);