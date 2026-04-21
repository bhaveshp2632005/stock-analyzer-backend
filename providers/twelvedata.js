/**
 * providers/twelvedata.js
 * TwelveData provider — US + Indian stocks
 *
 * Supports: US + .NS/.BO Indian symbols
 * Free tier: 8 req/min, 800 req/day
 * Docs: https://twelvedata.com/docs
 */

import axios from "axios";

export const NAME = "TwelveData";

const getKey = () => process.env.TWELVE_DATA_KEY;

const SIZE_MAP = {
  "1W": { outputsize: 7,   interval: "1day" },
  "1M": { outputsize: 30,  interval: "1day" },
  "3M": { outputsize: 90,  interval: "1day" },
  "6M": { outputsize: 26,  interval: "1week"},
  "1Y": { outputsize: 52,  interval: "1week"},
  "5Y": { outputsize: 60,  interval: "1month"},
};

/**
 * supports(symbol) — TwelveData handles both US and Indian (.NS) symbols
 */
export const supports = (_symbol) => true;

/**
 * fetch(symbol, range) → normalized candle data or throws
 */
export const fetch = async (symbol, range) => {
  const key = getKey();
  if (!key) throw new Error("TWELVE_DATA_KEY not set");

  const { outputsize, interval } = SIZE_MAP[range] || SIZE_MAP["1M"];
  const isIndian = /\.(NS|BO)$/i.test(symbol);

  // TwelveData uses different symbol format for Indian stocks
  // RELIANCE.NS → RELIANCE:NSE  or just pass as-is (both work)
  const tdSymbol = symbol;

  const [tsRes, quoteRes] = await Promise.allSettled([
    axios.get("https://api.twelvedata.com/time_series", {
      params:  { symbol: tdSymbol, interval, outputsize, apikey: key },
      timeout: 12000,
    }),
    axios.get("https://api.twelvedata.com/quote", {
      params:  { symbol: tdSymbol, apikey: key },
      timeout: 8000,
    }),
  ]);

  // Candles
  if (tsRes.status === "rejected") {
    throw new Error(`TwelveData time_series failed: ${tsRes.reason?.message}`);
  }
  const td = tsRes.value?.data;
  if (td?.status === "error" || !td?.values?.length) {
    throw new Error(`TwelveData: ${td?.message || "no values"}`);
  }

  const candles = [...td.values].reverse().map(v => ({
    date:   v.datetime.slice(0, 10),
    open:   +Number(v.open).toFixed(4),
    high:   +Number(v.high).toFixed(4),
    low:    +Number(v.low).toFixed(4),
    close:  +Number(v.close).toFixed(4),
    volume: +Number(v.volume || 0),
  })).filter(c => c.close > 0);

  if (!candles.length) throw new Error("TwelveData: empty candles after filter");

  // Quote (for live price)
  let price, open, high, low, prevClose, changePercent;
  if (quoteRes.status === "fulfilled" && quoteRes.value?.data?.close) {
    const qt = quoteRes.value.data;
    price         = +Number(qt.close).toFixed(2);
    open          = qt.open          ? +Number(qt.open).toFixed(2)           : undefined;
    high          = qt.high          ? +Number(qt.high).toFixed(2)           : undefined;
    low           = qt.low           ? +Number(qt.low).toFixed(2)            : undefined;
    prevClose     = qt.previous_close ? +Number(qt.previous_close).toFixed(2) : undefined;
    changePercent = qt.percent_change ?? undefined;
  } else {
    // Fall back to last candle
    const last = candles[candles.length - 1];
    price     = last.close;
    prevClose = candles.length > 1 ? candles[candles.length - 2].close : last.close;
    changePercent = prevClose ? +(((price - prevClose) / prevClose) * 100).toFixed(2) : 0;
  }

  return {
    symbol,
    name:          td.meta?.symbol || symbol,
    price,
    open,
    high,
    low,
    prevClose,
    changePercent: String(changePercent ?? 0),
    currency:      isIndian ? "INR" : "USD",
    exchange:      isIndian ? "NSE" : (td.meta?.exchange || "NASDAQ"),
    candles,
    provider:      NAME,
  };
};