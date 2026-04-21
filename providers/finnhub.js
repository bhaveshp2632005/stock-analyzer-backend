/**
 * providers/finnhub.js
 * Finnhub provider — US stocks (quote + candles)
 *
 * Supports: US symbols only
 * Free tier: 60 req/min
 * Docs: https://finnhub.io/docs/api
 */

import axios from "axios";

export const NAME = "Finnhub";

const getKey = () => process.env.FINNHUB_KEY || process.env.FINNHUB_API_KEY;

/* Range → Finnhub resolution + timestamp window */
const RESOLUTION_MAP = {
  "1W": { resolution: "D",  days: 7   },
  "1M": { resolution: "D",  days: 30  },
  "3M": { resolution: "D",  days: 90  },
  "6M": { resolution: "W",  days: 180 },
  "1Y": { resolution: "W",  days: 365 },
  "5Y": { resolution: "M",  days: 1825},
};

/**
 * supports(symbol) — Finnhub only handles US symbols well
 */
export const supports = (symbol) => !/\.(NS|BO|NSE|BSE)$/i.test(symbol);

/**
 * fetch(symbol, range) → normalized candle data or throws
 */
export const fetch = async (symbol, range) => {
  const key = getKey();
  if (!key) throw new Error("FINNHUB_KEY not set");

  const { resolution, days } = RESOLUTION_MAP[range] || RESOLUTION_MAP["1M"];
  const now  = Math.floor(Date.now() / 1000);
  const from = now - days * 86400;

  // Parallel: live quote + historical candles
  const [quoteRes, candleRes] = await Promise.allSettled([
    axios.get("https://finnhub.io/api/v1/quote", {
      params:  { symbol, token: key },
      timeout: 8000,
    }),
    axios.get("https://finnhub.io/api/v1/stock/candle", {
      params:  { symbol, resolution, from, to: now, token: key },
      timeout: 12000,
    }),
  ]);

  // Quote
  if (quoteRes.status === "rejected" || !quoteRes.value?.data?.c) {
    throw new Error(`Finnhub quote failed: ${quoteRes.reason?.message || "no data"}`);
  }
  const q = quoteRes.value.data;
  if (q.c === 0) throw new Error(`Finnhub: zero price for ${symbol}`);

  // Candles
  let candles = [];
  if (candleRes.status === "fulfilled") {
    const cd = candleRes.value?.data;
    if (cd?.s === "ok" && cd.t?.length) {
      candles = cd.t.map((t, i) => ({
        date:   new Date(t * 1000).toISOString().slice(0, 10),
        open:   +Number(cd.o[i]).toFixed(4),
        high:   +Number(cd.h[i]).toFixed(4),
        low:    +Number(cd.l[i]).toFixed(4),
        close:  +Number(cd.c[i]).toFixed(4),
        volume: cd.v[i] || 0,
      })).filter(c => c.close > 0);
    }
  }

  const prev    = q.pc || (candles.length > 1 ? candles[candles.length - 2].close : q.c);
  const chgPct  = prev ? +(((q.c - prev) / prev) * 100).toFixed(2) : 0;

  return {
    symbol,
    name:          symbol,
    price:         +q.c.toFixed(2),
    open:          +q.o.toFixed(2),
    high:          +q.h.toFixed(2),
    low:           +q.l.toFixed(2),
    prevClose:     +prev.toFixed(2),
    changePercent: String(chgPct),
    currency:      "USD",
    exchange:      "NASDAQ",
    candles,
    provider:      NAME,
  };
};