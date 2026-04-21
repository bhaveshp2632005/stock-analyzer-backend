/**
 * providerHealth.js
 * In-memory health tracker for each data provider.
 *
 * Tracks:
 *  • health status: "healthy" | "rate_limited" | "failed"
 *  • total / failed requests
 *  • average response time (ms)
 *  • last success / last error timestamp
 *  • rate-limit cooldown expiry
 *
 * Providers are automatically re-enabled after their cooldown window.
 */

const RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000;  // 5 min cooldown after rate-limit
const FAILURE_COOLDOWN_MS    = 2 * 60 * 1000;  // 2 min cooldown after repeated failures
const HIGH_FAILURE_THRESHOLD = 0.6;             // 60% failure rate → deprioritize

const registry = new Map(); // providerName → HealthEntry

const defaultEntry = () => ({
  status:          "healthy",      // "healthy" | "rate_limited" | "failed"
  totalRequests:   0,
  failedRequests:  0,
  avgResponseMs:   0,
  lastSuccessAt:   null,
  lastErrorAt:     null,
  cooldownUntil:   null,           // timestamp — skip provider until this time
  lastError:       null,
});

/* ── get or create entry ── */
const getEntry = (name) => {
  if (!registry.has(name)) registry.set(name, defaultEntry());
  return registry.get(name);
};

/* ────────────────────────────────────────────────
   PUBLIC API
──────────────────────────────────────────────── */

/**
 * isAvailable(name) — can we use this provider right now?
 * Automatically clears expired cooldowns.
 */
export const isAvailable = (name) => {
  const e = getEntry(name);
  if (e.cooldownUntil && Date.now() < e.cooldownUntil) return false;

  // Cooldown expired — restore to healthy
  if (e.cooldownUntil && Date.now() >= e.cooldownUntil) {
    e.status       = "healthy";
    e.cooldownUntil = null;
    console.log(`[Health] ${name} cooldown expired — restored to healthy`);
  }

  return e.status === "healthy";
};

/**
 * recordSuccess(name, responseMs) — call after a successful fetch
 */
export const recordSuccess = (name, responseMs = 0) => {
  const e = getEntry(name);
  e.totalRequests++;
  e.lastSuccessAt = Date.now();
  e.status        = "healthy";
  e.cooldownUntil = null;

  // Rolling average response time (last 10 requests weighted)
  e.avgResponseMs = e.avgResponseMs === 0
    ? responseMs
    : Math.round(e.avgResponseMs * 0.9 + responseMs * 0.1);
};

/**
 * recordFailure(name, error) — call after any error
 * Detects rate limits vs general failures and sets cooldown accordingly.
 */
export const recordFailure = (name, error) => {
  const e = getEntry(name);
  e.totalRequests++;
  e.failedRequests++;
  e.lastErrorAt = Date.now();
  e.lastError   = error?.message || String(error);

  const isRateLimit =
    error?.response?.status === 429 ||
    /rate.?limit|quota|too many|429/i.test(e.lastError);

  if (isRateLimit) {
    e.status       = "rate_limited";
    e.cooldownUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
    console.warn(`[Health] ⏸  ${name} RATE LIMITED — cooldown ${RATE_LIMIT_COOLDOWN_MS / 60000} min`);
    return;
  }

  // High failure rate? Apply shorter cooldown + deprioritize
  const failureRate = e.totalRequests > 0 ? e.failedRequests / e.totalRequests : 0;
  if (failureRate >= HIGH_FAILURE_THRESHOLD && e.totalRequests >= 3) {
    e.status       = "failed";
    e.cooldownUntil = Date.now() + FAILURE_COOLDOWN_MS;
    console.warn(`[Health] ❌ ${name} HIGH FAILURE RATE (${(failureRate * 100).toFixed(0)}%) — cooldown ${FAILURE_COOLDOWN_MS / 60000} min`);
  }
};

/**
 * getScore(name) — lower is better (for sorting providers by preference)
 * Penalises slow, rate-limited, or high-failure-rate providers.
 */
export const getScore = (name) => {
  const e = getEntry(name);
  if (!isAvailable(name)) return Infinity;

  const failureRate = e.totalRequests > 0 ? e.failedRequests / e.totalRequests : 0;
  const speedPenalty = e.avgResponseMs;             // ms (0 if never used)
  const failurePenalty = failureRate * 10000;        // scaled

  return speedPenalty + failurePenalty;
};

/**
 * sortByHealth(names) — return provider names sorted best → worst
 */
export const sortByHealth = (names) =>
  [...names]
    .filter(isAvailable)
    .sort((a, b) => getScore(a) - getScore(b));

/**
 * getStats() — returns full health snapshot for logging / debug
 */
export const getStats = () => {
  const out = {};
  for (const [name, e] of registry.entries()) {
    out[name] = {
      status:        e.status,
      available:     isAvailable(name),
      totalRequests: e.totalRequests,
      failedRequests: e.failedRequests,
      failureRate:   e.totalRequests > 0
        ? (e.failedRequests / e.totalRequests * 100).toFixed(1) + "%"
        : "0%",
      avgResponseMs: e.avgResponseMs,
      lastSuccessAt: e.lastSuccessAt ? new Date(e.lastSuccessAt).toISOString() : null,
      lastError:     e.lastError,
      cooldownUntil: e.cooldownUntil ? new Date(e.cooldownUntil).toISOString() : null,
    };
  }
  return out;
};

/**
 * resetProvider(name) — manually restore a provider (for testing / admin)
 */
export const resetProvider = (name) => {
  registry.set(name, defaultEntry());
};