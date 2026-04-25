/**
 * utils/symbolNormalizer.js
 *
 * Maps index symbols to synthetic .NS equivalents that travel
 * cleanly through the provider engine.
 *
 * IMPORTANT — handles TWO input forms:
 *   ^NSEI   (frontend sends this; Express usually preserves the ^)
 *   NSEI    (Express strips ^ from :symbol route params in some configs)
 *
 * Both forms map to NIFTY50.NS so the engine always receives a clean symbol.
 * Yahoo provider reverse-maps NIFTY50.NS → ^NSEI for its own API calls.
 * NseIndia provider explicitly rejects synthetic index symbols.
 * All other symbols (AAPL, RELIANCE.NS …) pass through unchanged.
 */

const INDEX_MAP = {
  // with caret
  "^NSEI":    "NIFTY50.NS",
  "^BSESN":   "SENSEX.NS",
  "^NSEBANK": "BANKNIFTY.NS",
  // without caret (Express strips ^ in some router/middleware configs)
  "NSEI":     "NIFTY50.NS",
  "BSESN":    "SENSEX.NS",
  "NSEBANK":  "BANKNIFTY.NS",
};

const DISPLAY_NAMES = {
  "^NSEI":    "NIFTY 50",
  "^BSESN":   "SENSEX",
  "^NSEBANK": "BANK NIFTY",
  "NSEI":     "NIFTY 50",
  "BSESN":    "SENSEX",
  "NSEBANK":  "BANK NIFTY",
};

/**
 * normalizeSymbol(raw)
 * Maps ^NSEI / NSEI → NIFTY50.NS etc.
 * No-op for all other symbols.
 */
export const normalizeSymbol = (raw = "") => {
  const upper = String(raw).toUpperCase().trim();
  return INDEX_MAP[upper] ?? upper;
};

/**
 * isIndexSymbol(raw)
 * Returns true for both ^NSEI and bare NSEI forms.
 */
export const isIndexSymbol = (raw = "") =>
  String(raw).toUpperCase().trim() in INDEX_MAP;

/**
 * getSymbolType(raw)
 * "INDEX" | "STOCK"
 */
export const getSymbolType = (raw = "") =>
  isIndexSymbol(raw) ? "INDEX" : "STOCK";

/**
 * getDisplayName(raw)
 * Human-readable label for known indices; falls back to symbol itself.
 */
export const getDisplayName = (raw = "") =>
  DISPLAY_NAMES[String(raw).toUpperCase().trim()] ??
  String(raw).toUpperCase().trim();