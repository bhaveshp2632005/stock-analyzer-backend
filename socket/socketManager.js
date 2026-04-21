import { getLiveStock } from "../controllers/stock.controller.js";

const POLL_INTERVAL_MS = 15000;

const symbolCache     = new Map();
const symbolIntervals = new Map();

export const registerSocketHandlers = (io) => {
  io.on("connection", (socket) => {
    console.log(`🔌 Client connected: ${socket.id}`);

    let currentSymbol = null;

    socket.on("subscribeStock", async (symbol) => {
      if (!symbol) return;
      symbol = symbol.toUpperCase();

      if (currentSymbol && currentSymbol !== symbol) {
        unsubscribe(socket.id, currentSymbol);
      }

      currentSymbol = symbol;
      console.log(`📈 ${socket.id} subscribed to ${symbol}`);

      if (symbolCache.has(symbol)) {
        socket.emit("stockUpdate", symbolCache.get(symbol).data);
      }

      if (!symbolIntervals.has(symbol)) {
        startPolling(symbol, io, socket.id); // ✅ no await — non-blocking
      } else {
        symbolIntervals.get(symbol).subscribers.add(socket.id);
      }
    });

    socket.on("unsubscribeStock", () => {
      if (currentSymbol) {
        unsubscribe(socket.id, currentSymbol);
        currentSymbol = null;
      }
      console.log(`🔕 ${socket.id} unsubscribed`);
    });

    socket.on("disconnect", () => {
      if (currentSymbol) unsubscribe(socket.id, currentSymbol);
      console.log(`❌ Client disconnected: ${socket.id}`);
    });
  });
};

/* ── Start polling ── */
const startPolling = (symbol, io, firstSocketId) => {
  const subscribers = new Set([firstSocketId]);

  // ✅ Set entry with a placeholder BEFORE any async work
  const entry = { intervalId: null, subscribers };
  symbolIntervals.set(symbol, entry);

  // First fetch — non-blocking, errors won't crash the server
  fetchAndBroadcast(symbol, io).catch((err) =>
    console.error(`Initial fetch failed for ${symbol}:`, err.message)
  );

  // ✅ Set interval immediately — no await needed
  entry.intervalId = setInterval(() => {
    fetchAndBroadcast(symbol, io).catch((err) =>
      console.error(`Poll fetch failed for ${symbol}:`, err.message)
    );
  }, POLL_INTERVAL_MS);
};

/* ── Fetch + broadcast ── */
const fetchAndBroadcast = async (symbol, io) => {
  try {
    const data = await getLiveStock(symbol);

    symbolCache.set(symbol, { data, lastFetched: Date.now() });

    const entry = symbolIntervals.get(symbol);
    if (entry) {
      entry.subscribers.forEach((socketId) => {
        io.to(socketId).emit("stockUpdate", data);
      });
      console.log(`📡 ${symbol} → ${entry.subscribers.size} client(s) | $${data.price}`);
    }
  } catch (err) {
    console.error(`Broadcast error for ${symbol}:`, err.message);

    const entry = symbolIntervals.get(symbol);
    if (entry) {
      entry.subscribers.forEach((socketId) => {
        io.to(socketId).emit("stockError", { message: `Feed error for ${symbol}` });
      });
    }
  }
};

/* ── Remove socket from subscribers ── */
const unsubscribe = (socketId, symbol) => {
  const entry = symbolIntervals.get(symbol);
  if (!entry) return;

  entry.subscribers.delete(socketId);

  if (entry.subscribers.size === 0) {
    clearInterval(entry.intervalId);
    symbolIntervals.delete(symbol);
    symbolCache.delete(symbol);
    console.log(`🛑 Stopped polling ${symbol} — no subscribers`);
  }
};

