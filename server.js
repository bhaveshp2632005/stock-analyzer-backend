import "dotenv/config";
import express      from "express";
import cors         from "cors";
import helmet       from "helmet";
import rateLimit    from "express-rate-limit";
import { createServer } from "http";
import { Server }   from "socket.io";

import connectDB         from "./config/db.js";
import authRoutes        from "./routes/auth.routes.js";
import analysisRoutes    from "./routes/analysis.routes.js";
import stockRoutes       from "./routes/stock.routes.js";
import aiRoutes          from "./routes/aiAnalysis.js";
import moversRoutes      from "./routes/movers.routes.js";
import favoritesRoutes   from "./routes/favorites.routes.js";   // ← NEW
import { registerSocketHandlers } from "./socket/socketManager.js";
import newsRoutes        from "./routes/news.routes.js";  
import aiRoutess from "./routes/ai.routes.js";
   // ← NEW
/* ── DB ── */
connectDB();

const app        = express();
const httpServer = createServer(app);

/* ══════════════════════════════════════════
   SECURITY HEADERS
══════════════════════════════════════════ */
app.use(helmet());

/* ══════════════════════════════════════════
   CORS
══════════════════════════════════════════ */
const allowedOrigins = [
  "http://localhost:5173",
  "http://localhost:3000",
  process.env.FRONTEND_URL,
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error(`CORS blocked: ${origin}`));
  },
  credentials: true,
}));

app.use(express.json({ limit: "10kb" }));

/* ══════════════════════════════════════════
   RATE LIMITING
══════════════════════════════════════════ */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      20,
  message:  { message: "Too many attempts. Try again in 15 minutes." },
  standardHeaders: true, legacyHeaders: false,
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      60,
  message:  { message: "Too many requests. Slow down." },
  standardHeaders: true, legacyHeaders: false,
});

/* ══════════════════════════════════════════
   ROUTES
══════════════════════════════════════════ */
app.use("/api/auth",      authLimiter, authRoutes);
app.use("/api/stock",     apiLimiter,  stockRoutes);
app.use("/api/ai",        apiLimiter,  aiRoutes);
app.use("/api/analysis",  apiLimiter,  analysisRoutes);
app.use("/api/movers",    apiLimiter,  moversRoutes);
app.use("/api/favorites", apiLimiter,  favoritesRoutes);   // ← NEW
app.use("/api/news", apiLimiter,newsRoutes);
app.use("/api/ai", apiLimiter,aiRoutess);

app.get("/", (_req, res) => res.send("StockAnalyzer Backend Running 🚀"));

/* ══════════════════════════════════════════
   GLOBAL ERROR HANDLER
══════════════════════════════════════════ */
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err.message);
  const isDev = process.env.NODE_ENV !== "production";
  res.status(err.status || 500).json({
    message: isDev ? err.message : "Internal server error",
  });
});

/* ══════════════════════════════════════════
   SOCKET.IO — with JWT auth middleware
══════════════════════════════════════════ */
import jwt from "jsonwebtoken";

const io = new Server(httpServer, {
  cors: {
    origin:      allowedOrigins,
    methods:     ["GET", "POST"],
    credentials: true,
  },
});

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error("Socket: No token provided."));
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    socket.userId = decoded.id;
    next();
  } catch (err) {
    return next(new Error("Socket: Invalid or expired token."));
  }
});

registerSocketHandlers(io);

/* ══════════════════════════════════════════
   START
══════════════════════════════════════════ */
const PORT = process.env.PORT || 5000;
httpServer.listen(PORT, () =>
  console.log(`🚀 Server running on http://localhost:${PORT}`)
);