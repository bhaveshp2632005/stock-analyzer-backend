/**
 * providers/nseIndia.js
 * NSE India provider — Indian stocks only
 *
 * Supports: .NS / .BO symbols (strips suffix internally)
 * Package: stock-nse-india
 * Rate limit: Informal — no strict limit for reasonable use
 */

export const NAME = "NseIndia";

const toNSE = (s) => s.replace(/\.(NS|BO|NSE|BSE)$/i, "");
const isIndian = (s) => /\.(NS|BO|NSE|BSE)$/i.test(s);

export const supports = (symbol) => isIndian(symbol);

export const fetch = async (symbol, range) => {
  if (!isIndian(symbol)) throw new Error(`NseIndia: ${symbol} is not an Indian symbol`);

  const { NseIndia } = await import("stock-nse-india");
  const nse       = new NseIndia();
  const nseSymbol = toNSE(symbol);

  // Calculate date range for historical data
  const DAYS = { "1W": 7, "1M": 30, "3M": 90, "6M": 180, "1Y": 365, "5Y": 1825 };
  const days  = DAYS[range] || 30;
  const end   = new Date();
  const start = new Date(); start.setDate(start.getDate() - days - 10); // buffer

  const [details, historical] = await Promise.all([
    nse.getEquityDetails(nseSymbol),
    nse.getEquityHistoricalData(nseSymbol, { start, end }),
  ]);

  if (!details?.priceInfo?.lastPrice) throw new Error(`NseIndia: no priceInfo for ${nseSymbol}`);

  const price     = details.priceInfo.lastPrice;
  const prevClose = details.priceInfo.previousClose || price;
  const chgPct    = prevClose ? (((price - prevClose) / prevClose) * 100).toFixed(2) : "0";

  // Parse historical candles — NSE returns data in different shapes
  let raw = [];
  if (Array.isArray(historical)) {
    if (historical[0]?.data)               raw = historical.flatMap(x => x.data || []);
    else if (historical[0]?.CH_TIMESTAMP)  raw = historical;
    else if (Array.isArray(historical[0])) raw = historical.flat();
  } else if (historical?.data) {
    raw = historical.data;
  }

  const candles = raw.map(d => {
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

  // If historical data is empty but we have live price, build a minimal candle
  // so the engine can still use this provider for current-day data
  if (!candles.length) {
    console.warn(`[NseIndia] No historical candles for ${nseSymbol} — using live price only`);
    candles = [{
      date:   new Date().toISOString().slice(0, 10),
      open:   details.priceInfo.open          || price,
      high:   details.priceInfo.intraDayHighLow?.max || price,
      low:    details.priceInfo.intraDayHighLow?.min || price,
      close:  price,
      volume: details.marketDeptOrderBook?.tradeInfo?.totalTradedVolume || 0,
    }];
  }

  return {
    symbol,
    name:          details.info?.companyName || nseSymbol,
    price:         +price.toFixed(2),
    open:          details.priceInfo.open          ? +Number(details.priceInfo.open).toFixed(2)                 : undefined,
    high:          details.priceInfo.intraDayHighLow?.max ? +Number(details.priceInfo.intraDayHighLow.max).toFixed(2) : undefined,
    low:           details.priceInfo.intraDayHighLow?.min ? +Number(details.priceInfo.intraDayHighLow.min).toFixed(2) : undefined,
    prevClose:     +prevClose.toFixed(2),
    changePercent: chgPct,
    currency:      "INR",
    exchange:      "NSE",
    candles,
    provider:      NAME,
  };
};

/* ── Also export getLiveQuote for socket manager ── */
export const getLiveQuote = async (symbol) => {
  const { NseIndia } = await import("stock-nse-india");
  const nse     = new NseIndia();
  const details = await nse.getEquityDetails(toNSE(symbol));
  if (!details?.priceInfo?.lastPrice) throw new Error(`NseIndia: no price for ${symbol}`);

  const price = details.priceInfo.lastPrice;
  const prev  = details.priceInfo.previousClose || price;
  return {
    symbol, price: +price.toFixed(2),
    changePercent: (((price - prev) / prev) * 100).toFixed(2),
    open:      details.priceInfo.open,
    high:      details.priceInfo.intraDayHighLow?.max,
    low:       details.priceInfo.intraDayHighLow?.min,
    prevClose: prev,
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