/**
 * utils/indicators.js
 * Technical indicator calculations for stock.controller.js
 *
 * Exports:
 *   calculateRSI(closes)          — RSI value for a 14-bar window
 *   calculateMACD(closes)         — MACD line value (EMA12 - EMA26)
 *   calculateEMA(closes, period)  — single EMA value for the full series
 *   emaSeries(closes, period)     — full EMA array aligned to closes array
 */

/* ── RSI ── */
export const calculateRSI = (closes) => {
  if (!closes || closes.length < 2) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains  += diff;
    else           losses -= diff;
  }
  const n        = closes.length - 1;
  const avg_gain = gains  / n;
  const avg_loss = losses / n;
  if (avg_loss === 0) return 100;
  const rs = avg_gain / avg_loss;
  return +( 100 - 100 / (1 + rs) ).toFixed(2);
};

/* ── MACD ── */
export const calculateMACD = (closes) => {
  if (!closes || closes.length < 26) return null;
  const ema = (data, period) => {
    const k   = 2 / (period + 1);
    let   val = data.slice(0, period).reduce((s, v) => s + v, 0) / period;
    for (let i = period; i < data.length; i++) val = data[i] * k + val * (1 - k);
    return val;
  };
  return +( ema(closes, 12) - ema(closes, 26) ).toFixed(4);
};

/* ── EMA single value ── */
export const calculateEMA = (closes, period = 20) => {
  if (!closes || closes.length < period) return null;
  const k   = 2 / (period + 1);
  let   ema = closes.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return +ema.toFixed(4);
};

/* ── EMA full series (aligned to closes array, nulls before period-1) ── */
export const emaSeries = (closes, period = 20) => {
  if (!closes || closes.length < period) return closes ? closes.map(() => null) : [];
  const k   = 2 / (period + 1);
  let   ema = closes.slice(0, period).reduce((s, v) => s + v, 0) / period;
  const out = closes.map(() => null);
  out[period - 1] = +ema.toFixed(4);
  for (let i = period; i < closes.length; i++) {
    ema    = closes[i] * k + ema * (1 - k);
    out[i] = +ema.toFixed(4);
  }
  return out;
};