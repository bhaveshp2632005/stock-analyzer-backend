import axios from "axios";

const INDEX_MAP = {
  "^NSEI": "NIFTY 50",
  "^BSESN": "SENSEX",
  "^NSEBANK": "NIFTY BANK",
};

export const getIndexData = async (req, res) => {
  try {
    const symbol = (req.params.symbol || "").toUpperCase().trim();

    if (!INDEX_MAP[symbol]) {
      return res.status(400).json({ error: "Unsupported index symbol" });
    }

    let price = null;
    let prevClose = null;

    /* ───────────── YAHOO FINANCE (PRIMARY) ───────────── */
    try {
      const { data } = await axios.get(
        `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`,
        { timeout: 5000 }
      );

      const result = data?.chart?.result?.[0];

      if (result) {
        price = result.meta.regularMarketPrice;
        prevClose = result.meta.previousClose;
      }
    } catch (err) {
      console.warn("Yahoo failed:", err.message);
    }

    /* ───────────── NSE FALLBACK ───────────── */
    if (!price) {
      try {
        const { NseIndia } = await import("stock-nse-india");
        const nse = new NseIndia();

        if (symbol === "^NSEI") {
          const d = await nse.getEquityIndices("NIFTY 50");
          price = d.last;
          prevClose = d.previousClose;
        }

        if (symbol === "^NSEBANK") {
          const d = await nse.getEquityIndices("NIFTY BANK");
          price = d.last;
          prevClose = d.previousClose;
        }
      } catch (err) {
        console.warn("NSE fallback failed:", err.message);
      }
    }

    /* ───────────── FINAL CHECK ───────────── */
    if (!price) {
      return res.status(404).json({
        error: "Index data not available",
        symbol,
      });
    }

    const change = +(price - prevClose).toFixed(2);
    const changePercent = prevClose
      ? +((change / prevClose) * 100).toFixed(2)
      : 0;

    return res.json({
      symbol,
      name: INDEX_MAP[symbol],
      price: +price.toFixed(2),
      change,
      changePercent,
      currency: "INR",
    });

  } catch (err) {
    console.error("Index API error:", err.message);

    return res.status(500).json({
      error: "Failed to fetch index data",
      symbol: req.params.symbol,
    });
  }
};