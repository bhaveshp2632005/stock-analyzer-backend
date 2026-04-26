/**
 * providers/yahoo.js
 * Yahoo Finance — Universal fallback provider for ALL asset classes
 *
 * Handles: US stocks, ETFs, Indian stocks, Indian/US/Global indices,
 *          Crypto, Forex, UK/Japan/Germany/HK/Canada/Australia stocks
 *
 * Fixes:
 *  1. NORMALIZED_TO_YAHOO map — NIFTY50.NS → ^NSEI in the actual API URL
 *  2. Index symbols skip crumb auth — they are public Yahoo endpoints.
 *     Crumb homepage fetch causes "Header overflow" on Render/Railway.
 *  3. Lightweight crumb endpoint — avoids massive Set-Cookie header overflow.
 */

import axios from "axios";

export const NAME = "Yahoo";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36";

/* ── Crumb cache ── */
let _crumbCache = null;

/**
 * Lightweight crumb fetch — uses query1 endpoint directly.
 * Does NOT scrape finance.yahoo.com homepage (causes Header overflow on cloud hosts).
 */
const getYahooCrumb = async () => {
  const now = Date.now();
  if (_crumbCache && _crumbCache.expiresAt > now) return _crumbCache;

  const crumbRes = await axios.get(
    "https://query1.finance.yahoo.com/v1/test/getcrumb",
    {
      timeout: 10000,
      headers: {
        "User-Agent":      UA,
        "Accept":          "*/*",
        "Accept-Language": "en-US,en;q=0.9",
      },
      maxContentLength: 100 * 1024,
      maxBodyLength:    100 * 1024,
      maxRedirects:     3,
    }
  );

  const crumb = String(crumbRes.data || "").trim();
  if (!crumb || crumb.includes("<")) throw new Error("Failed to get Yahoo crumb");

  const cookies = (crumbRes.headers["set-cookie"] || [])
    .map(c => c.split(";")[0])
    .join("; ");

  _crumbCache = { crumb, cookies, expiresAt: now + 55 * 60 * 1000 };
  console.log(`[Yahoo] Crumb acquired: ${crumb.slice(0, 8)}…`);
  return _crumbCache;
};

const RANGE_MAP = {
  "1W": { yRange: "5d",  interval: "1d"  },
  "1M": { yRange: "1mo", interval: "1d"  },
  "3M": { yRange: "3mo", interval: "1d"  },
  "6M": { yRange: "6mo", interval: "1wk" },
  "1Y": { yRange: "1y",  interval: "1wk" },
  "5Y": { yRange: "5y",  interval: "1mo" },
};

const isIndian = (s) => /\.(NS|BO|NSE|BSE)$/i.test(s);

/**
 * Reverse map: normalized index symbols → Yahoo native tickers.
 * normalizeSymbol() converts ^NSEI → NIFTY50.NS before this provider.
 * Yahoo's API only accepts ^NSEI, so we translate back here.
 */
const NORMALIZED_TO_YAHOO = {
  "NIFTY50.NS":   "^NSEI",
  "BANKNIFTY.NS": "^NSEBANK",
  "SENSEX.NS":    "^BSESN",
};

/**
 * ^ symbols on Yahoo are fully public — no crumb/cookie needed.
 * Skipping crumb for these avoids Header overflow on cloud hosts.
 */
const isPublicYahooSymbol = (yahooSym) =>
  String(yahooSym).startsWith("^") ||
  /^[A-Z0-9]{2,10}-(USD|INR|EUR|GBP|BTC|ETH|USDT)$/i.test(yahooSym) || // crypto
  /=X$/i.test(yahooSym); // forex

export const supports = (_symbol) => true; // universal — handles everything

export const fetch = async (symbol, range) => {
  // Translate normalized index symbols to Yahoo-native form
  const yahooSymbol = NORMALIZED_TO_YAHOO[symbol] ?? symbol;

  const { yRange, interval } = RANGE_MAP[range] || RANGE_MAP["1M"];
  let data;
  let lastErr;

  // Public symbols skip crumb entirely — avoids Header overflow
  const crumbAttempts = isPublicYahooSymbol(yahooSymbol) ? [false] : [true, false];

  for (const useCrumb of crumbAttempts) {
    try {
      const params  = { range: yRange, interval, includePrePost: false };
      const headers = {
        "User-Agent":      UA,
        "Accept":          "application/json",
        "Accept-Language": "en-US,en;q=0.9",
      };

      if (useCrumb) {
        try {
          const auth     = await getYahooCrumb();
          params.crumb   = auth.crumb;
          if (auth.cookies) headers.Cookie = auth.cookies;
        } catch (crumbErr) {
          // Non-fatal — proceed without crumb
          console.warn(`[Yahoo] Crumb failed (${crumbErr.message}) — proceeding without`);
        }
      }

      for (const host of ["query1", "query2"]) {
        try {
          const url = `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}`;
          const res = await axios.get(url, { params, headers, timeout: 14000 });
          data = res.data;
          if (data?.chart?.result?.[0]) break;
        } catch (hostErr) {
          if (host === "query2") throw hostErr;
        }
      }
      if (data?.chart?.result?.[0]) break;
    } catch (e) {
      lastErr = e;
      if (useCrumb) _crumbCache = null;
    }
  }

  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(lastErr?.message || `Yahoo: no data for ${yahooSymbol}`);

  const meta = result.meta;
  const ts   = result.timestamp || [];
  const q    = result.indicators?.quote?.[0] || {};

  const candles = ts.map((t, i) => ({
    date:   new Date(t * 1000).toISOString().slice(0, 10),
    open:   q.open?.[i]   != null ? +q.open[i].toFixed(4)  : null,
    high:   q.high?.[i]   != null ? +q.high[i].toFixed(4)  : null,
    low:    q.low?.[i]    != null ? +q.low[i].toFixed(4)   : null,
    close:  q.close?.[i]  != null ? +q.close[i].toFixed(4) : null,
    volume: q.volume?.[i] || 0,
  })).filter(c => c.close && c.close > 0 && c.open && c.high && c.low);

  if (!candles.length) throw new Error(`Yahoo: empty candles for ${yahooSymbol}`);

  const last      = candles[candles.length - 1];
  const prevClose = meta.chartPreviousClose || meta.previousClose
    || (candles.length > 1 ? candles[candles.length - 2].close : last.close);
  const price     = meta.regularMarketPrice || last.close;
  const chgPct    = prevClose ? +((( price - prevClose) / prevClose) * 100).toFixed(2) : 0;

  return {
    symbol,          // normalized form (NIFTY50.NS), not yahooSymbol (^NSEI)
    name:          meta.shortName || meta.longName || symbol,
    price:         +Number(price).toFixed(2),
    open:          meta.regularMarketOpen    != null ? +Number(meta.regularMarketOpen).toFixed(2)    : last.open,
    high:          meta.regularMarketDayHigh != null ? +Number(meta.regularMarketDayHigh).toFixed(2) : last.high,
    low:           meta.regularMarketDayLow  != null ? +Number(meta.regularMarketDayLow).toFixed(2)  : last.low,
    prevClose:     +Number(prevClose).toFixed(2),
    changePercent: String(chgPct),
    currency:      meta.currency || (isIndian(symbol) ? "INR" : "USD"),
    exchange:      meta.fullExchangeName || meta.exchangeName || (isIndian(symbol) ? "NSE" : "NASDAQ"),
    candles,
    provider:      NAME,
  };
};