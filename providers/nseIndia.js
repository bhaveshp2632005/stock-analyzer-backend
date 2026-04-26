/**
 * providers/nseIndia.js
 * NSE India provider — real Indian equity stocks only
 *
 * Supports: .NS / .BO symbols (strips suffix internally)
 * Does NOT support synthetic index symbols: NIFTY50.NS, BANKNIFTY.NS, SENSEX.NS
 *   — those are routed directly to Yahoo by providerEngine
 *
 * Package: stock-nse-india
 */

export const NAME = "NseIndia";

const toNSE     = (s)  => s.replace(/\.(NS|BO|NSE|BSE)$/i, "");
const isIndian  = (s)  => /\.(NS|BO|NSE|BSE)$/i.test(s);

// Synthetic index symbols created by normalizeSymbol() — NseIndia can't handle these
const SYNTHETIC_INDICES = new Set([
  "NIFTY50.NS",
  "BANKNIFTY.NS",
  "SENSEX.NS",
]);

export const supports = (symbol) =>
  isIndian(symbol) && !SYNTHETIC_INDICES.has(symbol.toUpperCase());

export const fetch = async (symbol, range) => {
  if (!isIndian(symbol))
    throw new Error(`NseIndia: ${symbol} is not an Indian symbol`);
  if (SYNTHETIC_INDICES.has(symbol.toUpperCase()))
    throw new Error(`NseIndia: ${symbol} is a synthetic index — handled by Yahoo`);

  const { NseIndia } = await import("stock-nse-india");
  const nse       = new NseIndia();
  const nseSymbol = toNSE(symbol);

  const DAYS = { "1W": 7, "1M": 30, "3M": 90, "6M": 180, "1Y": 365, "5Y": 1825 };
  const days  = DAYS[range] || 30;
  const end   = new Date();
  const start = new Date();
  start.setDate(start.getDate() - days - 10);

  const [details, historical] = await Promise.all([
    nse.getEquityDetails(nseSymbol),
    nse.getEquityHistoricalData(nseSymbol, { start, end }),
  ]);

  if (!details?.priceInfo?.lastPrice)
    throw new Error(`NseIndia: no priceInfo for ${nseSymbol}`);

  const price     = details.priceInfo.lastPrice;
  const prevClose = details.priceInfo.previousClose || price;
  const chgPct    = prevClose ? (((price - prevClose) / prevClose) * 100).toFixed(2) : "0";

  let raw = [];
  if (Array.isArray(historical)) {
    if (historical[0]?.data)               raw = historical.flatMap(x => x.data || []);
    else if (historical[0]?.CH_TIMESTAMP)  raw = historical;
    else if (Array.isArray(historical[0])) raw = historical.flat();
  } else if (historical?.data) {
    raw = historical.data;
  }

  let candles = raw.map(d => {
    const rd = d.CH_TIMESTAMP || d.chTIMESTAMP || d.mtimestamp || d.date || "";
    return {
      date:   rd.includes("T") ? rd.split("T")[0] : rd.slice(0, 10),
      open:   +(d.CH_OPENING_PRICE    || d.open   || 0),
      high:   +(d.CH_TRADE_HIGH_PRICE || d.high   || 0),
      low:    +(d.CH_TRADE_LOW_PRICE  || d.low    || 0),
      close:  +(d.CH_CLOSING_PRICE    || d.close  || 0),
      volume: +(d.CH_TOT_TRADED_QTY   || d.volume || 0),
    };
  })
  .filter(v => v.close > 0 && v.date?.length === 10)
  .sort((a, b) => new Date(a.date) - new Date(b.date));

  if (!candles.length) {
    console.warn(`[NseIndia] No historical candles for ${nseSymbol} — using live price only`);
    candles = [{
      date:   new Date().toISOString().slice(0, 10),
      open:   details.priceInfo.open                   || price,
      high:   details.priceInfo.intraDayHighLow?.max   || price,
      low:    details.priceInfo.intraDayHighLow?.min   || price,
      close:  price,
      volume: details.marketDeptOrderBook?.tradeInfo?.totalTradedVolume || 0,
    }];
  }

  return {
    symbol,
    name:          details.info?.companyName || nseSymbol,
    price:         +price.toFixed(2),
    open:          details.priceInfo.open
                     ? +Number(details.priceInfo.open).toFixed(2)
                     : undefined,
    high:          details.priceInfo.intraDayHighLow?.max
                     ? +Number(details.priceInfo.intraDayHighLow.max).toFixed(2)
                     : undefined,
    low:           details.priceInfo.intraDayHighLow?.min
                     ? +Number(details.priceInfo.intraDayHighLow.min).toFixed(2)
                     : undefined,
    prevClose:     +prevClose.toFixed(2),
    changePercent: chgPct,
    currency:      "INR",
    exchange:      "NSE",
    candles,
    provider:      NAME,
  };
};

/* ── getLiveQuote for socket / quick API ── */
export const getLiveQuote = async (symbol) => {
  if (SYNTHETIC_INDICES.has(symbol.toUpperCase()))
    throw new Error(`NseIndia: ${symbol} is a synthetic index — use Yahoo`);

  const { NseIndia } = await import("stock-nse-india");
  const nse     = new NseIndia();
  const details = await nse.getEquityDetails(toNSE(symbol));

  if (!details?.priceInfo?.lastPrice)
    throw new Error(`NseIndia: no price for ${symbol}`);

  const price = details.priceInfo.lastPrice;
  const prev  = details.priceInfo.previousClose || price;

  return {
    symbol,
    price:         +price.toFixed(2),
    changePercent: (((price - prev) / prev) * 100).toFixed(2),
    open:          details.priceInfo.open,
    high:          details.priceInfo.intraDayHighLow?.max,
    low:           details.priceInfo.intraDayHighLow?.min,
    prevClose:     prev,
    currency:      "INR",
    tick: {
      time:   new Date().toISOString(),
      close:  price,
      open:   details.priceInfo.open || price,
      high:   details.priceInfo.intraDayHighLow?.max || price,
      low:    details.priceInfo.intraDayHighLow?.min || price,
      volume: details.marketDeptOrderBook?.tradeInfo?.totalTradedVolume || 0,
    },
  };
};