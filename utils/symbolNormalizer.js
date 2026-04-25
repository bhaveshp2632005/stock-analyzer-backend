/**
 * utils/symbolNormalizer.js
 *
 * Single source of truth for index symbol mapping.
 *
 * Maps index symbols (^NSEI, ^BSESN, ^NSEBANK) to synthetic .NS equivalents
 * that travel cleanly through the provider engine.
 *
 * Yahoo provider then reverse-maps these back to ^NSEI etc. for its API calls.
 * NseIndia provider explicitly rejects them so Yahoo gets the fallback.
 *
 * ALL other symbols (AAPL, RELIANCE.NS, TCS.NS …) pass through unchanged.
 */

/** ^-style index → normalized fetchable symbol */
const INDEX_MAP = {
  "^NSEI":    "NIFTY50.NS",
  "^BSESN":   "SENSEX.NS",
  "^NSEBANK": "BANKNIFTY.NS",
};

/** Display names shown in the UI */
const DISPLAY_NAMES = {
  "^NSEI":    "NIFTY 50",
  "^BSESN":   "SENSEX",
  "^NSEBANK": "BANK NIFTY",
};

/**
 * normalizeSymbol(raw)
 * Maps ^NSEI → NIFTY50.NS etc.
 * For all other symbols this is a no-op (uppercase + trim only).
 *
 * @param {string} raw - symbol as received from client
 * @returns {string}   - symbol safe to pass to providerEngine
 */
export const normalizeSymbol = (raw = "") => {
  const upper = String(raw).toUpperCase().trim();
  return INDEX_MAP[upper] ?? upper;
};

/**
 * isIndexSymbol(raw)
 * Returns true for recognized ^-style index inputs.
 */
export const isIndexSymbol = (raw = "") =>
  String(raw).toUpperCase().trim() in INDEX_MAP;

/**
 * getSymbolType(raw)
 * Returns "INDEX" for recognized index symbols, "STOCK" for everything else.
 * Used to tag API responses so the frontend can render accordingly.
 */
export const getSymbolType = (raw = "") =>
  isIndexSymbol(raw) ? "INDEX" : "STOCK";

/**
 * getDisplayName(raw)
 * Human-readable label for known indices; falls back to the symbol itself.
 *
 * @param {string} raw
 * @returns {string}
 */
export const getDisplayName = (raw = "") =>
  DISPLAY_NAMES[String(raw).toUpperCase().trim()] ?? String(raw).toUpperCase().trim();