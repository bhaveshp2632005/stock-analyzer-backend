/**
 * movers.controller.js — Top Gainers & Losers
 *
 * FIX: Added ?force=true support — manual refresh bypasses server-side cache
 *      so the Refresh button always fetches genuinely fresh data.
 *
 * Goal 3: Server-side cache — movers cached 2 min, rapid refreshes
 *         don't hammer Finnhub / NSE APIs
 * Goal 4: Background Dashboard refresh hits cache instantly
 *
 * US stocks:     Finnhub quote API  (24 symbols, parallel)
 * Indian stocks: stock-nse-india    (20 symbols, parallel)
 * Both market groups fetched simultaneously via Promise.all
 */

import axios from "axios";
import {
  serverCacheGet,
  serverCacheSet,
} from "./stockCache.js";

const getFinnhubKey = () => process.env.FINNHUB_KEY || process.env.FINNHUB_API_KEY;

const US_SYMBOLS = [
  "AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "TSLA", "META", "NFLX",
  "AMD",  "INTC", "ORCL",  "CRM",  "ADBE", "PYPL", "UBER", "LYFT",
  "BABA", "SHOP", "SQ",    "PLTR", "COIN", "SNAP", "RBLX", "SOFI",
];

const IN_SYMBOLS = [
  "RELIANCE", "TCS",      "HDFCBANK",  "INFY",
  "ICICIBANK","KOTAKBANK","LT",        "SBIN",
  "AXISBANK", "HINDUNILVR","BAJFINANCE","MARUTI",
  "TITAN",    "WIPRO",    "ULTRACEMCO","ASIANPAINT",
  "POWERGRID","NTPC",     "ONGC",      "HCLTECH",
];

const CACHE_KEY = "movers:all";
const CACHE_TTL = 2 * 60 * 1000;

/* ── Fetch one US quote ── */
const fetchUSQuote = async (symbol, token) => {
  const { data } = await axios.get("https://finnhub.io/api/v1/quote", {
    params: { symbol, token }, timeout: 8000,
  });
  if (!data?.c || data.c === 0) throw new Error(`No data for ${symbol}`);
  const changePercent = data.pc
    ? +((( data.c - data.pc) / data.pc) * 100).toFixed(2) : 0;
  return {
    symbol,
    price:         +data.c.toFixed(2),
    changePercent,
    change:        +(data.c - (data.pc || data.c)).toFixed(2),
    high:          data.h ? +data.h.toFixed(2) : null,
    low:           data.l ? +data.l.toFixed(2) : null,
    currency:      "USD",
    market:        "US",
  };
};

/* ── Fetch one Indian quote ── */
const fetchINQuote = async (nseSymbol) => {
  const { NseIndia } = await import("stock-nse-india");
  const nse     = new NseIndia();
  const details = await nse.getEquityDetails(nseSymbol);
  if (!details?.priceInfo?.lastPrice) throw new Error(`No priceInfo for ${nseSymbol}`);

  const price     = details.priceInfo.lastPrice;
  const prevClose = details.priceInfo.previousClose || price;
  const changePercent = prevClose
    ? +((( price - prevClose) / prevClose) * 100).toFixed(2) : 0;
  return {
    symbol:        nseSymbol + ".NS",
    price:         +price.toFixed(2),
    changePercent,
    change:        +(price - prevClose).toFixed(2),
    high:          details.priceInfo.intraDayHighLow?.max ?? null,
    low:           details.priceInfo.intraDayHighLow?.min ?? null,
    currency:      "INR",
    market:        "IN",
  };
};

/* ══════════════════════════════════════════════════════════════
   HANDLER   GET /api/movers
   Query params:
     ?force=true  — bypass server cache, fetch fresh data immediately
══════════════════════════════════════════════════════════════ */
export const getTopMovers = async (req, res) => {
  try {
    /* ── FIX: ?force=true skips cache so Refresh button gets real fresh data ── */
    const forceRefresh = req.query.force === "true";

    if (!forceRefresh) {
      const cached = serverCacheGet(CACHE_KEY);
      if (cached) {
        console.log("⚡ Movers cache HIT");
        return res.json(cached);
      }
    } else {
      console.log("🔄 Movers force refresh — bypassing server cache");
    }

    const finnhubKey = getFinnhubKey();
    if (!finnhubKey) {
      return res.status(500).json({ error: "FINNHUB_KEY not set in .env" });
    }

    console.log("📊 Fetching movers — US + NSE India in parallel…");

    /* Fetch both markets simultaneously */
    const [usResults, inResults] = await Promise.all([
      Promise.allSettled(US_SYMBOLS.map((sym) => fetchUSQuote(sym, finnhubKey))),
      Promise.allSettled(IN_SYMBOLS.map((sym) => fetchINQuote(sym))),
    ]);

    const allStocks = [
      ...usResults.map((r, i) => {
        if (r.status === "fulfilled") return r.value;
        console.warn(`US skip ${US_SYMBOLS[i]}: ${r.reason?.message}`);
        return null;
      }),
      ...inResults.map((r, i) => {
        if (r.status === "fulfilled") return r.value;
        console.warn(`IN skip ${IN_SYMBOLS[i]}: ${r.reason?.message}`);
        return null;
      }),
    ].filter(Boolean);

    if (allStocks.length === 0) {
      return res.status(502).json({
        error: "Could not fetch any stock data. Check API keys and connectivity.",
      });
    }

    const sorted  = [...allStocks].sort((a, b) => b.changePercent - a.changePercent);
    const gainers = sorted.filter((s) => s.changePercent > 0).slice(0, 8);
    const losers  = sorted.filter((s) => s.changePercent < 0).reverse().slice(0, 8);

    console.log(`✅ Movers ready: ${gainers.length} gainers, ${losers.length} losers (${allStocks.length} total)`);

    const payload = {
      gainers,
      losers,
      totalFetched: allStocks.length,
      fetchedAt:    new Date().toISOString(),
    };

    /* Always re-cache fresh result */
    serverCacheSet(CACHE_KEY, payload, CACHE_TTL);

    return res.json(payload);

  } catch (err) {
    console.error("getTopMovers FATAL:", err.message);
    return res.status(500).json({ error: "Failed to fetch market movers. Please try again." });
  }
};