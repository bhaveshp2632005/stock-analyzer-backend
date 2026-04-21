import Groq from "groq-sdk";

export const runGroqExplanation = async ({
  action,
  indicators,
  trend,
  confidence,
}) => {
  if (!process.env.GROQ_API_KEY) {
    throw new Error("GROQ_API_KEY missing at runtime");
  }

  const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY,
  });

  const prompt = `
You are a stock market AI assistant.

Stock Summary:
- Recommendation: ${action}
- RSI: ${indicators.rsi}
- MACD: ${indicators.macd}
- Trend: ${trend.label} (${trend.percent}%)
- Confidence: ${confidence}%

Explain the reasoning in simple, professional language.
Do NOT give financial advice.
Limit to 4–5 lines.
`;

  const completion = await groq.chat.completions.create({
    model: "llama-3.1-8b-instant",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.4,
  });

  return completion.choices[0].message.content;
};
