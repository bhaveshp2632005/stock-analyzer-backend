/**
 * stockCache.js — Server-side in-memory cache for stock data
 *
 * Prevents hammering external APIs (Finnhub/TwelveData/Yahoo/NSE)
 * on repeated requests for same symbol+range within TTL window.
 *
 * Import and use inside stock.controller.js:
 *
 *   import { serverCacheGet, serverCacheSet, serverCacheKey, serverCacheTTL } from "./stockCache.js";
 *
 *   const key = serverCacheKey(symbol, range);
 *   const hit = serverCacheGet(key);
 *   if (hit) return res.json(hit);
 *   // ... fetch ...
 *   serverCacheSet(key, responseData, serverCacheTTL(range));
 *   return res.json(responseData);
 */

const cache = new Map();

const TTL_MS = {
  "1W": 2  * 60 * 1000,
  "1M": 3  * 60 * 1000,
  "3M": 5  * 60 * 1000,
  "6M": 5  * 60 * 1000,
  "1Y": 5  * 60 * 1000,
  "5Y": 10 * 60 * 1000,
};

export const serverCacheKey = (symbol, range) => `${symbol}:${range}`;
export const serverCacheTTL = (range) => TTL_MS[range] ?? 3 * 60 * 1000;

export const serverCacheGet = (key) => {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { cache.delete(key); return null; }
  return entry.data;
};

export const serverCacheSet = (key, data, ttl) => {
  cache.set(key, { data, expiresAt: Date.now() + ttl });
};

export const serverCacheDelete = (keyOrPrefix) => {
  for (const k of cache.keys()) {
    if (k === keyOrPrefix || k.startsWith(keyOrPrefix)) cache.delete(k);
  }
};

// Cleanup expired entries every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of cache.entries()) {
    if (now > v.expiresAt) cache.delete(k);
  }
}, 10 * 60 * 1000);