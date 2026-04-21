/**
 * controllers/favorites.controller.js
 * ─────────────────────────────────────────────────────────────────
 * Uses getLiveStock() from existing stock.controller — same source
 * that powers Socket.IO, so prices are consistent everywhere.
 *
 * Alert logic:
 *  - alertFiredAbove / alertFiredBelow stored in DB
 *  - Once fired, won't re-fire until user calls updateAlert
 *  - updateAlert always resets both fired flags
 *
 * Endpoints:
 *  GET    /api/favorites              → getAll
 *  POST   /api/favorites              → add
 *  PUT    /api/favorites/:symbol      → updateAlert
 *  DELETE /api/favorites/:symbol      → remove
 *  GET    /api/favorites/prices       → getPrices
 *  POST   /api/favorites/check-alerts → checkAlerts
 */

import Favorite        from "../models/Favorite.model.js";
import { getLiveStock } from "./stock.controller.js";

/* ══════════════════════════════════════════
   GET ALL  —  GET /api/favorites
══════════════════════════════════════════ */
export const getAll = async (req, res) => {
  try {
    const favorites = await Favorite.find({ userId: req.user.id })
      .sort({ createdAt: -1 })
      .lean();
    res.json(favorites);
  } catch (err) {
    console.error("favorites getAll:", err.message);
    res.status(500).json({ error: "Failed to fetch favorites" });
  }
};

/* ══════════════════════════════════════════
   ADD  —  POST /api/favorites
   Body: { symbol, alertAbove?, alertBelow? }
══════════════════════════════════════════ */
export const add = async (req, res) => {
  try {
    const { symbol, alertAbove = null, alertBelow = null } = req.body;
    if (!symbol) return res.status(400).json({ error: "symbol is required" });

    const sym = String(symbol).toUpperCase().trim();

    if (alertAbove !== null && isNaN(Number(alertAbove)))
      return res.status(400).json({ error: "alertAbove must be a number" });
    if (alertBelow !== null && isNaN(Number(alertBelow)))
      return res.status(400).json({ error: "alertBelow must be a number" });

    const favorite = await Favorite.findOneAndUpdate(
      { userId: req.user.id, symbol: sym },
      {
        userId:          req.user.id,
        symbol:          sym,
        alertAbove:      alertAbove !== null ? Number(alertAbove) : null,
        alertBelow:      alertBelow !== null ? Number(alertBelow) : null,
        alertFiredAbove: false,
        alertFiredBelow: false,
      },
      { upsert: true, new: true, runValidators: true }
    );

    res.status(201).json({ success: true, favorite });
  } catch (err) {
    if (err.code === 11000)
      return res.status(409).json({ error: "Already in favorites" });
    console.error("favorites add:", err.message);
    res.status(500).json({ error: "Failed to add favorite" });
  }
};

/* ══════════════════════════════════════════
   UPDATE ALERT  —  PUT /api/favorites/:symbol
   Body: { alertAbove?, alertBelow? }
   Resets fired flags so new thresholds fire fresh.
══════════════════════════════════════════ */
export const updateAlert = async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase().trim();
    const { alertAbove = null, alertBelow = null } = req.body;

    const favorite = await Favorite.findOneAndUpdate(
      { userId: req.user.id, symbol },
      {
        alertAbove:      alertAbove !== null ? Number(alertAbove) : null,
        alertBelow:      alertBelow !== null ? Number(alertBelow) : null,
        alertFiredAbove: false,
        alertFiredBelow: false,
      },
      { new: true }
    );

    if (!favorite) return res.status(404).json({ error: "Favorite not found" });
    res.json({ success: true, favorite });
  } catch (err) {
    console.error("favorites updateAlert:", err.message);
    res.status(500).json({ error: "Failed to update alert" });
  }
};

/* ══════════════════════════════════════════
   REMOVE  —  DELETE /api/favorites/:symbol
══════════════════════════════════════════ */
export const remove = async (req, res) => {
  try {
    const symbol  = req.params.symbol.toUpperCase().trim();
    const deleted = await Favorite.findOneAndDelete({ userId: req.user.id, symbol });
    if (!deleted) return res.status(404).json({ error: "Favorite not found" });
    res.json({ success: true });
  } catch (err) {
    console.error("favorites remove:", err.message);
    res.status(500).json({ error: "Failed to remove favorite" });
  }
};

/* ══════════════════════════════════════════
   GET PRICES  —  GET /api/favorites/prices
   Returns live price snapshot for all favorites.
   Uses getLiveStock() — same as Socket.IO feed.
══════════════════════════════════════════ */
export const getPrices = async (req, res) => {
  try {
    const favorites = await Favorite.find({ userId: req.user.id }).lean();
    if (!favorites.length) return res.json({});

    const results = {};

    // Fetch all in parallel — max 10 at a time to respect rate limits
    const CHUNK = 10;
    for (let i = 0; i < favorites.length; i += CHUNK) {
      await Promise.allSettled(
        favorites.slice(i, i + CHUNK).map(async (fav) => {
          try {
            const live = await getLiveStock(fav.symbol);
            results[fav.symbol] = {
              price:         live.price,
              changePercent: live.changePercent,
              currency:      live.currency || (fav.symbol.includes(".NS") ? "INR" : "USD"),
            };
          } catch {
            results[fav.symbol] = null;
          }
        })
      );
    }

    res.json(results);
  } catch (err) {
    console.error("favorites getPrices:", err.message);
    res.status(500).json({ error: "Failed to fetch prices" });
  }
};

/* ══════════════════════════════════════════
   CHECK ALERTS  —  POST /api/favorites/check-alerts
   Called by frontend polling every 90s.
   Server evaluates conditions, marks fired in DB,
   returns list of newly triggered alerts.
══════════════════════════════════════════ */
export const checkAlerts = async (req, res) => {
  try {
    // Only load favorites with at least one un-fired alert
    const candidates = await Favorite.find({
      userId: req.user.id,
      $or: [
        { alertAbove: { $ne: null }, alertFiredAbove: false },
        { alertBelow: { $ne: null }, alertFiredBelow: false },
      ],
    }).lean();

    if (!candidates.length) return res.json({ triggered: [] });

    const triggered = [];

    const CHUNK = 10;
    for (let i = 0; i < candidates.length; i += CHUNK) {
      await Promise.allSettled(
        candidates.slice(i, i + CHUNK).map(async (fav) => {
          try {
            const live  = await getLiveStock(fav.symbol);
            const price = Number(live.price);
            const currency = live.currency || (fav.symbol.includes(".NS") ? "INR" : "USD");
            const updates  = {};

            if (fav.alertAbove !== null && !fav.alertFiredAbove && price > fav.alertAbove) {
              updates.alertFiredAbove = true;
              triggered.push({
                symbol:    fav.symbol,
                price,
                currency,
                condition: "above",
                threshold: fav.alertAbove,
              });
            }

            if (fav.alertBelow !== null && !fav.alertFiredBelow && price < fav.alertBelow) {
              updates.alertFiredBelow = true;
              triggered.push({
                symbol:    fav.symbol,
                price,
                currency,
                condition: "below",
                threshold: fav.alertBelow,
              });
            }

            if (Object.keys(updates).length) {
              await Favorite.updateOne(
                { userId: req.user.id, symbol: fav.symbol },
                { $set: updates }
              );
            }
          } catch (err) {
            console.warn(`Alert check skip ${fav.symbol}: ${err.message}`);
          }
        })
      );
    }

    res.json({ triggered });
  } catch (err) {
    console.error("favorites checkAlerts:", err.message);
    res.status(500).json({ error: "Alert check failed" });
  }
};