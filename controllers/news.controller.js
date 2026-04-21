/**
 * controllers/news.controller.js
 *
 * Providers (parallel):
 *  1. Yahoo Finance Query API  — NO KEY, works for .NS/.BO stocks
 *  2. Finnhub                  — FINNHUB_KEY (already in .env)
 *  3. GNews                    — GNEWS_API_KEY (free 100/day at gnews.io)
 *
 * GET  /api/news/:symbol       → stored news, auto-refresh if stale
 * POST /api/news/fetch/:symbol → force fetch + store + return
 */

import axios from "axios";
import News  from "../models/News.js";

const FRESH_HOURS  = 1;
const MAX_ARTICLES = 20;
const MAX_DB_AGE_D = 7;

const toDateStr = (unix) => new Date(unix * 1000).toISOString().slice(0, 10);

const NAME_MAP = {
  RELIANCE:"Reliance Industries", TCS:"Tata Consultancy Services",
  HDFCBANK:"HDFC Bank",           INFY:"Infosys",
  ICICIBANK:"ICICI Bank",         KOTAKBANK:"Kotak Mahindra Bank",
  SBIN:"State Bank of India",     WIPRO:"Wipro",
  HINDUNILVR:"Hindustan Unilever",BAJFINANCE:"Bajaj Finance",
  MARUTI:"Maruti Suzuki",         TITAN:"Titan Company",
  HCLTECH:"HCL Technologies",     TATAMOTORS:"Tata Motors",
  TATASTEEL:"Tata Steel",         SUNPHARMA:"Sun Pharma",
  BHARTIARTL:"Bharti Airtel",     ADANIENT:"Adani Enterprises",
  ASIANPAINT:"Asian Paints",      ULTRACEMCO:"UltraTech Cement",
};

const toSearchTerm = (symbol) => {
  const base = symbol.replace(/\.(NS|BO|NSE|BSE)$/i, "");
  return NAME_MAP[base] || base;
};

/* ════════════════════════════════════════════════════════════
   PROVIDER 1 — Yahoo Finance v8 API (NO KEY, works for Indian)
════════════════════════════════════════════════════════════ */
const fetchFromYahoo = async (symbol) => {
  // Yahoo Finance v8 news endpoint — no auth needed
  const url = `https://query2.finance.yahoo.com/v8/finance/spark?symbols=${encodeURIComponent(symbol)}&range=1d&interval=5m`;

  // Actually use the news-specific endpoint
  const newsUrl = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(symbol)}&newsCount=${MAX_ARTICLES}&quotesCount=0&enableFuzzyQuery=false`;

  const { data } = await axios.get(newsUrl, {
    timeout: 8000,
    headers: {
      "User-Agent":  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Accept":      "application/json",
      "Referer":     "https://finance.yahoo.com",
    },
  });

  const items = data?.news;
  if (!Array.isArray(items) || !items.length)
    throw new Error("Yahoo: no news items");

  return items.map(a => ({
    symbol:      symbol.toUpperCase(),
    headline:    (a.title        || "").trim(),
    description: "",
    source:      (a.publisher    || "Yahoo Finance").trim(),
    url:         (a.link         || "").trim(),
    imageUrl:    a.thumbnail?.resolutions?.[0]?.url || "",
    publishedAt: a.providerPublishTime ? new Date(a.providerPublishTime * 1000) : new Date(),
  })).filter(a => a.headline && a.url);
};

/* ════════════════════════════════════════════════════════════
   PROVIDER 2 — Finnhub (FINNHUB_KEY in .env)
════════════════════════════════════════════════════════════ */
const fetchFromFinnhub = async (symbol) => {
  const key = process.env.FINNHUB_KEY || process.env.FINNHUB_API_KEY;
  if (!key) throw new Error("FINNHUB_KEY not set");

  const to   = Math.floor(Date.now() / 1000);
  const from = to - 7 * 24 * 3600;
  const base = symbol.replace(/\.(NS|BO|NSE|BSE)$/i, "");

  const { data } = await axios.get("https://finnhub.io/api/v1/company-news", {
    params:  { symbol: base, from: toDateStr(from), to: toDateStr(to), token: key },
    timeout: 8000,
  });

  if (!Array.isArray(data) || !data.length)
    throw new Error("Finnhub: no articles");

  return data.map(a => ({
    symbol:      symbol.toUpperCase(),
    headline:    (a.headline || "").trim(),
    description: (a.summary  || "").trim(),
    source:      (a.source   || "Finnhub").trim(),
    url:         (a.url      || "").trim(),
    imageUrl:    (a.image    || "").trim(),
    publishedAt: a.datetime ? new Date(a.datetime * 1000) : new Date(),
  })).filter(a => a.headline && a.url);
};


/* ════════════════════════════════════════════════════════════
   PROVIDER 3 — GNews (GNEWS_API_KEY, free 100/day)
   Register: https://gnews.io  → free plan, no credit card
   Add to .env: GNEWS_API_KEY=your_key
════════════════════════════════════════════════════════════ */
const fetchFromGNews = async (symbol) => {
  const key = process.env.GNEWS_API_KEY;
  if (!key) throw new Error("GNEWS_API_KEY not set");

  const query = toSearchTerm(symbol);

  const { data } = await axios.get("https://gnews.io/api/v4/search", {
    params: {
      q:      `"${query}"`,
      lang:   "en",
      max:    MAX_ARTICLES,
      sortby: "publishedAt",
      token:  key,
    },
    timeout: 8000,
  });

  const items = data?.articles;
  if (!Array.isArray(items) || !items.length)
    throw new Error("GNews: no articles");

  return items.map(a => ({
    symbol:      symbol.toUpperCase(),
    headline:    (a.title           || "").trim(),
    description: (a.description     || "").trim(),
    source:      (a.source?.name    || "GNews").trim(),
    url:         (a.url             || "").trim(),
    imageUrl:    (a.image           || "").trim(),
    publishedAt: a.publishedAt ? new Date(a.publishedAt) : new Date(),
  })).filter(a => a.headline && a.url);
};

/* ════════════════════════════════════════════════════════════
   STORE — duplicates silently skipped
════════════════════════════════════════════════════════════ */
const storeArticles = async (articles) => {
  let saved = 0, skipped = 0;
  await Promise.allSettled(
    articles.map(async (a) => {
      try   { await News.create(a); saved++; }
      catch (e) { if (e.code === 11000) skipped++; else throw e; }
    })
  );
  console.log(`[News] Stored: ${saved} new, ${skipped} duplicates skipped`);
  return saved;
};

/* ════════════════════════════════════════════════════════════
   FETCH + STORE — all 3 parallel, merge + deduplicate
════════════════════════════════════════════════════════════ */
const fetchAndStore = async (symbol) => {
  const [yahooRes, finnhubRes, gnewsRes] = await Promise.allSettled([
    fetchFromYahoo(symbol),
    fetchFromFinnhub(symbol),
    fetchFromGNews(symbol),
  ]);

  const log = (name, res) => {
    if (res.status === "fulfilled")
      console.log(`[News] ✅ ${name}: ${res.value.length} articles for ${symbol}`);
    else
      console.warn(`[News] ⚠️  ${name} failed: ${res.reason?.message}`);
  };
  log("Yahoo Finance", yahooRes);
  log("Finnhub",       finnhubRes);
  log("GNews",         gnewsRes);

  // Merge all successful
  const all = [
    ...(yahooRes.status       === "fulfilled" ? yahooRes.value       : []),
    ...(finnhubRes.status === "fulfilled" ? finnhubRes.value : []),
    ...(gnewsRes.status   === "fulfilled" ? gnewsRes.value   : []),
  ];

  if (!all.length) {
    console.warn(`[News] All providers failed for ${symbol}`);
    return { providers: [], fetched: 0, saved: 0 };
  }

  // Deduplicate by URL
  const seen   = new Set();
  const unique = all.filter(a => { if (seen.has(a.url)) return false; seen.add(a.url); return true; });

  console.log(`[News] Merged: ${all.length} total → ${unique.length} unique for ${symbol}`);

  const saved     = await storeArticles(unique);
  const providers = [
    yahooRes.status      === "fulfilled" && "Yahoo Finance",
    finnhubRes.status === "fulfilled" && "Finnhub",
    gnewsRes.status   === "fulfilled" && "GNews",
  ].filter(Boolean);

  return { providers, fetched: unique.length, saved };
};

/* ════════════════════════════════════════════════════════════
   GET /api/news/:symbol
════════════════════════════════════════════════════════════ */
export const getNews = async (req, res) => {
  try {
    const symbol   = (req.params.symbol || "").toUpperCase().trim();
    if (!symbol) return res.status(400).json({ error: "Symbol required" });

    const cutoff   = new Date(Date.now() - MAX_DB_AGE_D * 24 * 3600 * 1000);
    const freshCut = new Date(Date.now() - FRESH_HOURS * 3600 * 1000);

    const latest  = await News.findOne({ symbol }).sort({ createdAt: -1 }).lean();
    const isFresh = latest && new Date(latest.createdAt) > freshCut;

    if (!isFresh) {
      fetchAndStore(symbol).catch(e =>
        console.warn(`[News] Background refresh error: ${e.message}`)
      );
    }

    const articles = await News.find({ symbol, publishedAt: { $gte: cutoff } })
      .sort({ publishedAt: -1 })
      .limit(MAX_ARTICLES)
      .lean();

    return res.json({ symbol, articles, total: articles.length, fromCache: isFresh, fetchedAt: new Date().toISOString() });

  } catch (err) {
    console.error(`[News] getNews [${req.params.symbol}]:`, err.message);
    return res.status(500).json({ error: "Failed to load news" });
  }
};

/* ════════════════════════════════════════════════════════════
   POST /api/news/fetch/:symbol
════════════════════════════════════════════════════════════ */
export const fetchNews = async (req, res) => {
  try {
    const symbol = (req.params.symbol || "").toUpperCase().trim();
    if (!symbol) return res.status(400).json({ error: "Symbol required" });

    const { providers, fetched, saved } = await fetchAndStore(symbol);

    const cutoff   = new Date(Date.now() - MAX_DB_AGE_D * 24 * 3600 * 1000);
    const articles = await News.find({ symbol, publishedAt: { $gte: cutoff } })
      .sort({ publishedAt: -1 })
      .limit(MAX_ARTICLES)
      .lean();

    return res.json({ symbol, articles, total: articles.length, providers, fetched, saved, fetchedAt: new Date().toISOString() });

  } catch (err) {
    console.error(`[News] fetchNews [${req.params.symbol}]:`, err.message);
    return res.status(500).json({ error: "Failed to fetch news" });
  }
};