// utils/indicators.js

export const calculateRSI = (closes, period = 14) => {
  if (closes.length < period) return null;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }

  const avgGain = gains / period;
  const avgLoss = losses / period || 1;

  const rs = avgGain / avgLoss;
  const rsi = 100 - 100 / (1 + rs);

  return Number(rsi.toFixed(2));
};

const EMA = (data, period) => {
  const k = 2 / (period + 1);
  let ema = data[0];

  for (let i = 1; i < data.length; i++) {
    ema = data[i] * k + ema * (1 - k);
  }

  return ema;
};

export const calculateMACD = (closes) => {
  if (closes.length < 26) return null;

  const ema12 = EMA(closes.slice(-12), 12);
  const ema26 = EMA(closes.slice(-26), 26);
  const macd = ema12 - ema26;

  return Number(macd.toFixed(2));
};
