

import axios from "axios";
import {
  serverCacheGet,
  serverCacheSet,
} from "./stockCache.js";

const getFinnhubKey = () => process.env.FINNHUB_KEY || process.env.FINNHUB_API_KEY;

/* ── US symbols (24) ── */
const US_SYMBOLS = [
  "AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "TSLA", "META", "NFLX",
  "AMD",  "INTC", "ORCL",  "CRM",  "ADBE", "PYPL", "UBER", "LYFT",
  "BABA", "SHOP", "SQ",    "PLTR", "COIN", "SNAP", "RBLX", "SOFI",
];

/* ── Indian NSE symbols (30 most-traded) ── */
const IN_SYMBOLS = [
  "RELIANCE",   "TCS",        "HDFCBANK",   "INFY",       "ICICIBANK",
  "KOTAKBANK",  "LT",         "SBIN",       "AXISBANK",   "HINDUNILVR",
  "BAJFINANCE", "MARUTI",     "TITAN",      "WIPRO",      "ULTRACEMCO",
  "ASIANPAINT", "POWERGRID",  "NTPC",       "ONGC",       "HCLTECH",
  "SUNPHARMA",  "DRREDDY",    "CIPLA",      "DIVISLAB",   "ADANIENT",
  "ADANIPORTS", "TATAMOTORS", "TATASTEEL",  "JSWSTEEL",   "BHARTIARTL",
];

const CACHE_KEY     = "movers:all";
const CACHE_TTL     = 2 * 60 * 1000;   // 2 min
const STALE_TTL_KEY = "movers:stale";  // kept for 30 min as fallback

/* ────────────────────────────────────────────────────
   Fetch one US quote via Finnhub
──────────────────────────────────────────────────── */
const fetchUSQuote = async (symbol, token) => {
  const { data } = await axios.get("https://finnhub.io/api/v1/quote", {
    params:  { symbol, token },
    timeout: 8000,
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

/* ────────────────────────────────────────────────────
   Fetch one Indian NSE quote via stock-nse-india
   Falls back to Yahoo Finance v8 on NSE failure
──────────────────────────────────────────────────── */
const fetchINQuote = async (nseSymbol) => {
  /* ── Primary: stock-nse-india ── */
  try {
    const { NseIndia } = await import("stock-nse-india");
    const nse     = new NseIndia();
    const details = await nse.getEquityDetails(nseSymbol);
    if (!details?.priceInfo?.lastPrice) throw new Error("no priceInfo");

    const price     = details.priceInfo.lastPrice;
    const prevClose = details.priceInfo.previousClose || price;
    const chgPct    = prevClose
      ? +((( price - prevClose) / prevClose) * 100).toFixed(2) : 0;
    return {
      symbol:        nseSymbol + ".NS",
      price:         +price.toFixed(2),
      changePercent: chgPct,
      change:        +(price - prevClose).toFixed(2),
      high:          details.priceInfo.intraDayHighLow?.max ?? null,
      low:           details.priceInfo.intraDayHighLow?.min ?? null,
      currency:      "INR",
      market:        "IN",
    };
  } catch (nseErr) {
    /* ── Fallback: Yahoo Finance v8 ── */
    const yfSymbol = `${nseSymbol}.NS`;
    const url      = `https://query1.finance.yahoo.com/v8/finance/chart/${yfSymbol}`;
    const { data } = await axios.get(url, {
      timeout: 6000,
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Referer":    "https://finance.yahoo.com/",
      },
    });
    const result = data?.chart?.result?.[0];
    if (!result) throw new Error(`Yahoo: no data for ${yfSymbol}`);

    const meta      = result.meta;
    const price     = meta.regularMarketPrice;
    const prevClose = meta.previousClose ?? price;
    if (!price) throw new Error(`Yahoo: zero price for ${yfSymbol}`);

    const chgPct = prevClose
      ? +((( price - prevClose) / prevClose) * 100).toFixed(2) : 0;
    return {
      symbol:        yfSymbol,
      price:         +price.toFixed(2),
      changePercent: chgPct,
      change:        +(price - prevClose).toFixed(2),
      high:          meta.regularMarketDayHigh ?? null,
      low:           meta.regularMarketDayLow  ?? null,
      currency:      "INR",
      market:        "IN",
    };
  }
};

/* ════════════════════════════════════════════════════════════
   HANDLER   GET /api/movers[?force=true]
════════════════════════════════════════════════════════════ */
export const getTopMovers = async (req, res) => {
  try {
    const forceRefresh = req.query.force === "true";

    /* Cache check */
    if (!forceRefresh) {
      const cached = serverCacheGet(CACHE_KEY);
      if (cached) {
        console.log("⚡ Movers cache HIT");
        return res.json(cached);
      }
    } else {
      console.log("🔄 Movers force-refresh — bypassing cache");
    }

    const finnhubKey = getFinnhubKey();
    if (!finnhubKey) {
      return res.status(500).json({ error: "FINNHUB_KEY not set in .env" });
    }

    console.log("📊 Fetching movers — US + NSE India in parallel…");

    /* Fetch both markets simultaneously */
    const [usResults, inResults] = await Promise.all([
      Promise.allSettled(US_SYMBOLS.map(sym => fetchUSQuote(sym, finnhubKey))),
      Promise.allSettled(IN_SYMBOLS.map(sym => fetchINQuote(sym))),
    ]);

    const allStocks = [
      ...usResults.map((r, i) => {
        if (r.status === "fulfilled") return r.value;
        console.warn(`⚠  US  skip ${US_SYMBOLS[i]}: ${r.reason?.message}`);
        return null;
      }),
      ...inResults.map((r, i) => {
        if (r.status === "fulfilled") return r.value;
        console.warn(`⚠  NSE skip ${IN_SYMBOLS[i]}: ${r.reason?.message}`);
        return null;
      }),
    ].filter(Boolean);

    if (allStocks.length === 0) {
      /* Try stale cache as last resort */
      const stale = serverCacheGet(STALE_TTL_KEY);
      if (stale) {
        console.warn("⚠  All live sources failed — serving stale movers");
        return res.json({ ...stale, stale: true });
      }
      return res.status(502).json({
        error: "Could not fetch any stock data. Check API keys and connectivity.",
      });
    }

    console.log(`✅ Fetched ${allStocks.length} stocks (${allStocks.filter(s=>s.market==="US").length} US, ${allStocks.filter(s=>s.market==="IN").length} IN)`);

    /* Sort and slice */
    const sorted  = [...allStocks].sort((a, b) => b.changePercent - a.changePercent);
    const gainers = sorted.filter(s => s.changePercent > 0).slice(0, 10);
    const losers  = sorted.filter(s => s.changePercent < 0).reverse().slice(0, 10);

    console.log(`📈 ${gainers.length} gainers  📉 ${losers.length} losers`);

    const payload = {
      gainers,
      losers,
      totalFetched: allStocks.length,
      fetchedAt:    new Date().toISOString(),
      markets:      {
        us: allStocks.filter(s => s.market === "US").length,
        in: allStocks.filter(s => s.market === "IN").length,
      },
    };

    /* Cache both fresh (2 min) and stale (30 min) copies */
    serverCacheSet(CACHE_KEY,     payload, CACHE_TTL);
    serverCacheSet(STALE_TTL_KEY, payload, 30 * 60 * 1000);

    return res.json(payload);

  } catch (err) {
    console.error("getTopMovers FATAL:", err.message);
    return res.status(500).json({
      error: "Failed to fetch market movers. Please try again.",
    });
  }
};