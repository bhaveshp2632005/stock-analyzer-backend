/**
 * utils/symbolNormalizer.js
 *
 * Handles symbol normalization and type detection for ALL asset classes:
 *   US stocks/ETFs, Indian NSE/BSE stocks, Indian indices, US/Global indices,
 *   Crypto, Forex, UK, Japan, Germany, HK, Canada, Australia, France, Italy
 *
 * Indian index special handling:
 *   ^NSEI   / NSEI    → NIFTY50.NS    (bare form handles Express ^ stripping)
 *   ^BSESN  / BSESN   → SENSEX.NS
 *   ^NSEBANK/ NSEBANK  → BANKNIFTY.NS
 *
 * Yahoo provider reverse-maps NIFTY50.NS → ^NSEI for its own API calls.
 * All other symbols pass through unchanged (only uppercased + trimmed).
 */

// ── Indian index normalization ────────────────────────────────────────────────
const INDIAN_INDEX_MAP = {
  // with caret (standard form)
  "^NSEI":    "NIFTY50.NS",
  "^BSESN":   "SENSEX.NS",
  "^NSEBANK": "BANKNIFTY.NS",
  // without caret — Express strips ^ from :symbol route params in some configs
  "NSEI":     "NIFTY50.NS",
  "BSESN":    "SENSEX.NS",
  "NSEBANK":  "BANKNIFTY.NS",
};

// ── Human-readable display names for known indices ────────────────────────────
const DISPLAY_NAMES = {
  // Indian indices
  "^NSEI":    "NIFTY 50",
  "^BSESN":   "SENSEX",
  "^NSEBANK": "BANK NIFTY",
  "NSEI":     "NIFTY 50",
  "BSESN":    "SENSEX",
  "NSEBANK":  "BANK NIFTY",
  // US indices (pass through natively to Yahoo)
  "^GSPC":    "S&P 500",
  "^DJI":     "Dow Jones",
  "^IXIC":    "NASDAQ Composite",
  "^VIX":     "CBOE Volatility Index",
  "^RUT":     "Russell 2000",
  // Global indices
  "^FTSE":    "FTSE 100",
  "^N225":    "Nikkei 225",
  "^HSI":     "Hang Seng",
  "^GDAXI":   "DAX",
  "^FCHI":    "CAC 40",
};

/**
 * normalizeSymbol(raw)
 * Converts Indian index symbols to their .NS form so the provider
 * engine can route them correctly.
 * All other symbols: no-op (uppercase + trim only).
 */
export const normalizeSymbol = (raw = "") => {
  const upper = String(raw).toUpperCase().trim();
  return INDIAN_INDEX_MAP[upper] ?? upper;
};

/**
 * isIndexSymbol(raw)
 * True for ^ prefixed symbols AND bare Indian index names.
 */
export const isIndexSymbol = (raw = "") => {
  const upper = String(raw).toUpperCase().trim();
  return upper in INDIAN_INDEX_MAP || upper.startsWith("^");
};

/**
 * getSymbolType(raw)
 * Tags API responses so the frontend can render asset-specific UI.
 */
export const getSymbolType = (raw = "") => {
  const upper = String(raw).toUpperCase().trim();
  if (upper in INDIAN_INDEX_MAP || upper.startsWith("^"))         return "INDEX";
  if (/\.(NS|BO|NSE|BSE)$/i.test(upper))                         return "STOCK_IN";
  if (/^[A-Z0-9]{2,10}-(USD|INR|EUR|GBP|BTC|ETH|USDT)$/i.test(upper)) return "CRYPTO";
  if (/=X$/i.test(upper))                                         return "FOREX";
  if (/\.(L|T|DE|HK|TO|AX|PA|MI|F|SW|AS|MC|LS)$/i.test(upper)) return "STOCK_INTL";
  return "STOCK";
};

/**
 * getDisplayName(raw)
 * Human-readable label for known indices; falls back to symbol.
 */
export const getDisplayName = (raw = "") =>
  DISPLAY_NAMES[String(raw).toUpperCase().trim()] ??
  String(raw).toUpperCase().trim();