import { runGroqExplanation } from "./groqClient.js";


export const runAIPrediction = async ({
  indicators,
  price,
  prevClose,
  chart,
}) => {
  let action = "HOLD";
  let confidence = 50;
  let risk = "MEDIUM";
  let reasons = [];

  const { rsi, macd } = indicators;

  /* RSI */
  if (rsi > 70) {
    action = "SELL";
    confidence += 20;
  } else if (rsi < 30) {
    action = "BUY";
    confidence += 20;
  }

  /* MACD */
  if (macd < 0) {
    confidence += 15;
    if (action !== "BUY") action = "SELL";
  }

  /* PRICE */
  if (price < prevClose) confidence += 10;

  /* TREND */
  let trend = { label: "Sideways", percent: 0 };
  if (chart?.length >= 2) {
    const first = chart[0].close;
    const last = chart[chart.length - 1].close;
    const pct = (((last - first) / first) * 100).toFixed(2);

    trend =
      pct >= 0
        ? { label: "Uptrend", percent: pct }
        : { label: "Downtrend", percent: Math.abs(pct) };
  }

  /* RISK */
  if (confidence >= 80) risk = "HIGH";
  else if (confidence >= 60) risk = "MEDIUM";
  else risk = "LOW";

  if (confidence > 95) confidence = 95;

  /* 🔥 GEMINI EXPLANATION */
  const summary = await runGroqExplanation({
  action,
  indicators,
  trend,
  confidence,
});


  return {
    action,
    confidence,
    risk,
    trend,
    summary,
  };
};
