/**
 * indices.controller.js — Indian Market Indices (NIFTY 50, SENSEX, BANK NIFTY)
 *
 * FIX SUMMARY:
 *  1. decodeURIComponent(req.params.symbol) — handles %5ENSEI → ^NSEI
 *  2. Yahoo Finance v8 as primary (no API key needed)
 *  3. NSE India as secondary fallback
 *  4. Stooq as tertiary fallback
 *  5. Proper 400/404/500 error codes
 *  6. Debug logging for every step
 */

import axios from "axios";

/* ── Symbol metadata ── */
const INDEX_META = {
  "^NSEI":    { name: "NIFTY 50",   nseKey: "NIFTY 50",   stooqSym: "^NII50" },
  "^BSESN":   { name: "SENSEX",     nseKey: null,          stooqSym: "^BSE"   },
  "^NSEBANK": { name: "NIFTY BANK", nseKey: "NIFTY BANK",  stooqSym: "^NSEBANK" },
};

const SUPPORTED_SYMBOLS = Object.keys(INDEX_META);

/* ── Shared axios session with browser-like headers ── */
const session = axios.create({
  timeout: 8000,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Accept":          "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
  },
});

/* ═══════════════════════════════════════════════════════
   SOURCE 1 — Yahoo Finance v8 (no API key, most reliable)
═══════════════════════════════════════════════════════ */
const fetchFromYahoo = async (symbol) => {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`;
  console.log(`[Indices] Yahoo fetch: ${url}`);

  const { data } = await session.get(url, {
    headers: { Referer: "https://finance.yahoo.com/" },
  });

  const result = data?.chart?.result?.[0];
  if (!result) {
    const err = data?.chart?.error;
    throw new Error(`Yahoo: no result — ${JSON.stringify(err)}`);
  }

  const meta      = result.meta;
  const price     = meta.regularMarketPrice;
  const prevClose = meta.previousClose ?? meta.chartPreviousClose;
  const open      = meta.regularMarketOpen;

  if (!price) throw new Error("Yahoo: price is null/zero");

  const change        = +(price - prevClose).toFixed(2);
  const changePercent = prevClose
    ? +((change / prevClose) * 100).toFixed(2)
    : 0;

  console.log(`[Indices] Yahoo OK: ${symbol} → ${price} (${changePercent}%)`);
  return { price: +price.toFixed(2), prevClose: +prevClose.toFixed(2), open, change, changePercent };
};

/* ═══════════════════════════════════════════════════════
   SOURCE 2 — NSE India (npm: stock-nse-india)
═══════════════════════════════════════════════════════ */
const fetchFromNSE = async (symbol) => {
  const meta = INDEX_META[symbol];
  if (!meta?.nseKey) throw new Error("NSE: symbol not supported by NseIndia");

  const { NseIndia } = await import("stock-nse-india");
  const nse = new NseIndia();

  console.log(`[Indices] NSE fetch: ${meta.nseKey}`);
  const d = await nse.getEquityIndices(meta.nseKey);

  if (!d?.last) throw new Error(`NSE: no price for ${meta.nseKey}`);

  const price     = d.last;
  const prevClose = d.previousClose ?? price;
  const open      = d.open          ?? price;
  const change    = +(price - prevClose).toFixed(2);
  const changePct = prevClose ? +((change / prevClose) * 100).toFixed(2) : 0;

  console.log(`[Indices] NSE OK: ${symbol} → ${price} (${changePct}%)`);
  return { price: +price.toFixed(2), prevClose: +prevClose.toFixed(2), open, change, changePercent: changePct };
};

/* ═══════════════════════════════════════════════════════
   SOURCE 3 — Stooq (free CSV, no key)
═══════════════════════════════════════════════════════ */
const fetchFromStooq = async (symbol) => {
  const meta    = INDEX_META[symbol];
  const stooqSym = meta?.stooqSym ?? symbol;
  const now     = new Date();
  const d2      = now.toISOString().slice(0,10).replace(/-/g,"");
  const past    = new Date(now - 7 * 86400 * 1000).toISOString().slice(0,10).replace(/-/g,"");
  const url     = `https://stooq.com/q/d/l/?s=${stooqSym}&d1=${past}&d2=${d2}&i=d`;

  console.log(`[Indices] Stooq fetch: ${url}`);
  const { data } = await session.get(url, { responseType: "text" });

  const lines = data.trim().split("\n").filter(Boolean);
  if (lines.length < 2) throw new Error("Stooq: empty CSV response");

  // Last row is most recent trading day
  const cols  = lines[lines.length - 1].split(",");
  if (cols.length < 5) throw new Error("Stooq: unexpected CSV format");

  const [, open, , , close] = cols;
  const price     = parseFloat(close);
  const openPrice = parseFloat(open);
  if (!price) throw new Error("Stooq: invalid price in CSV");

  // Stooq doesn't give prev-close directly — use second-to-last row if available
  let prevClose = price;
  if (lines.length >= 3) {
    const prev = lines[lines.length - 2].split(",");
    prevClose  = parseFloat(prev[4]) || price;
  }

  const change    = +(price - prevClose).toFixed(2);
  const changePct = prevClose ? +((change / prevClose) * 100).toFixed(2) : 0;

  console.log(`[Indices] Stooq OK: ${symbol} → ${price} (${changePct}%)`);
  return { price: +price.toFixed(2), prevClose: +prevClose.toFixed(2), open: openPrice, change, changePercent: changePct };
};

/* ═══════════════════════════════════════════════════════
   MAIN HANDLER   GET /api/indices/:symbol
   Tries each source in order; returns first success.
═══════════════════════════════════════════════════════ */
export const getIndexData = async (req, res) => {
  /* FIX: decode %5ENSEI → ^NSEI */
  const raw    = req.params.symbol || "";
  const symbol = decodeURIComponent(raw).toUpperCase().trim();

  console.log(`[Indices] Request: raw="${raw}" decoded="${symbol}"`);

  /* Validate symbol */
  if (!SUPPORTED_SYMBOLS.includes(symbol)) {
    return res.status(400).json({
      error:   "Unsupported index symbol",
      symbol,
      supported: SUPPORTED_SYMBOLS,
    });
  }

  const meta   = INDEX_META[symbol];
  const errors = [];

  /* Try sources in order */
  const sources = [
    { name: "Yahoo",  fn: () => fetchFromYahoo(symbol) },
    { name: "NSE",    fn: () => fetchFromNSE(symbol)   },
    { name: "Stooq",  fn: () => fetchFromStooq(symbol) },
  ];

  for (const src of sources) {
    try {
      const d = await src.fn();
      return res.json({
        symbol,
        name:          meta.name,
        price:         d.price,
        change:        d.change,
        changePercent: d.changePercent,
        open:          d.open ? +d.open.toFixed(2) : d.price,
        prevClose:     d.prevClose,
        currency:      "INR",
        source:        src.name,
        fetchedAt:     new Date().toISOString(),
      });
    } catch (err) {
      const msg = `${src.name}: ${err.message}`;
      errors.push(msg);
      console.warn(`[Indices] ${msg}`);
    }
  }

  /* All sources failed */
  console.error(`[Indices] All sources failed for ${symbol}:`, errors);
  return res.status(404).json({
    error:   "Index data not available from any source",
    symbol,
    details: errors,
  });
};