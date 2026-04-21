/**
 * providers/alphavantage.js
 * AlphaVantage provider — US + Indian stocks
 *
 * Supports: US + Indian symbols (use BSE: prefix for Indian)
 * Free tier: 25 req/day (very limited — used as last resort)
 * Docs: https://www.alphavantage.co/documentation/
 */

import axios from "axios";

export const NAME = "AlphaVantage";

const getKey = () => process.env.ALPHA_VANTAGE_KEY || process.env.ALPHAVANTAGE_KEY;

/* Range → AV function + outputsize */
const FUNC_MAP = {
  "1W": { func: "TIME_SERIES_DAILY",        outputsize: "compact" },
  "1M": { func: "TIME_SERIES_DAILY",        outputsize: "compact" },
  "3M": { func: "TIME_SERIES_DAILY",        outputsize: "full"    },
  "6M": { func: "TIME_SERIES_WEEKLY",       outputsize: "full"    },
  "1Y": { func: "TIME_SERIES_WEEKLY",       outputsize: "full"    },
  "5Y": { func: "TIME_SERIES_MONTHLY",      outputsize: "full"    },
};

const DAYS_FOR_RANGE = { "1W": 7, "1M": 30, "3M": 90, "6M": 180, "1Y": 365, "5Y": 1825 };

const isIndian = (s) => /\.(NS|BO)$/i.test(s);

/* AlphaVantage uses BSE: prefix for Indian stocks on BSE */
const toAVSymbol = (symbol) => {
  if (/\.NS$/i.test(symbol)) return symbol.replace(/\.NS$/i, ".BSE"); // AV uses BSE suffix
  return symbol;
};

export const supports = (_symbol) => !!getKey();

export const fetch = async (symbol, range) => {
  const key = getKey();
  if (!key) throw new Error("ALPHA_VANTAGE_KEY not set");

  const { func, outputsize } = FUNC_MAP[range] || FUNC_MAP["1M"];
  const avSymbol = toAVSymbol(symbol);
  const days     = DAYS_FOR_RANGE[range] || 30;

  // Parallel: time series + global quote
  const [tsRes, quoteRes] = await Promise.allSettled([
    axios.get("https://www.alphavantage.co/query", {
      params:  { function: func, symbol: avSymbol, outputsize, apikey: key, datatype: "json" },
      timeout: 15000,
    }),
    axios.get("https://www.alphavantage.co/query", {
      params:  { function: "GLOBAL_QUOTE", symbol: avSymbol, apikey: key },
      timeout: 8000,
    }),
  ]);

  // Parse time series
  if (tsRes.status === "rejected") {
    throw new Error(`AlphaVantage time series failed: ${tsRes.reason?.message}`);
  }
  const tsData = tsRes.value?.data;

  // AV rate limit check (returns note instead of data)
  if (tsData?.Note || tsData?.Information) {
    const msg = tsData.Note || tsData.Information;
    const err = new Error(msg);
    err.response = { status: 429 }; // treat as rate limit
    throw err;
  }

  // Find the time series key (varies by function)
  const tsKey = Object.keys(tsData || {}).find(k => k.startsWith("Time Series"));
  if (!tsKey || !tsData[tsKey]) {
    throw new Error("AlphaVantage: no time series data");
  }

  const seriesObj = tsData[tsKey];
  const cutoff    = Date.now() - days * 86400 * 1000;

  const candles = Object.entries(seriesObj)
    .filter(([date]) => new Date(date).getTime() >= cutoff)
    .sort(([a], [b]) => new Date(a) - new Date(b))
    .map(([date, v]) => ({
      date,
      open:   +Number(v["1. open"]).toFixed(4),
      high:   +Number(v["2. high"]).toFixed(4),
      low:    +Number(v["3. low"]).toFixed(4),
      close:  +Number(v["4. close"]).toFixed(4),
      volume: +Number(v["5. volume"] || v["6. volume"] || 0),
    }))
    .filter(c => c.close > 0);

  if (!candles.length) throw new Error("AlphaVantage: empty candles");

  // Parse global quote for live price
  let price, open, high, low, prevClose, changePercent;
  if (quoteRes.status === "fulfilled") {
    const gq = quoteRes.value?.data?.["Global Quote"];
    if (gq?.["05. price"]) {
      price         = +Number(gq["05. price"]).toFixed(2);
      open          = gq["02. open"]              ? +Number(gq["02. open"]).toFixed(2)              : undefined;
      high          = gq["03. high"]              ? +Number(gq["03. high"]).toFixed(2)              : undefined;
      low           = gq["04. low"]               ? +Number(gq["04. low"]).toFixed(2)               : undefined;
      prevClose     = gq["08. previous close"]    ? +Number(gq["08. previous close"]).toFixed(2)    : undefined;
      changePercent = gq["10. change percent"]
        ? gq["10. change percent"].replace("%", "").trim()
        : undefined;
    }
  }

  if (!price) {
    const last = candles[candles.length - 1];
    price     = last.close;
    prevClose = candles.length > 1 ? candles[candles.length - 2].close : last.close;
    changePercent = prevClose ? String(+(((price - prevClose) / prevClose) * 100).toFixed(2)) : "0";
  }

  return {
    symbol,
    name:          symbol,
    price,
    open,
    high,
    low,
    prevClose,
    changePercent: String(changePercent ?? 0),
    currency:      isIndian(symbol) ? "INR" : "USD",
    exchange:      isIndian(symbol) ? "NSE" : "NASDAQ",
    candles,
    provider:      NAME,
  };
};