/**
 * Lightweight in-memory rate limiter for upload routes.
 *
 * Token-bucket keyed by `(userId || ip)`. Defaults to 20 uploads/min per
 * caller — generous enough for legitimate field use (a technician scanning
 * a row of racks back-to-back), strict enough to stop a runaway client
 * or stolen token from torching the worker pool with garbage uploads.
 *
 * Single-process only — fine while the server is a single Node instance.
 * If we ever scale horizontally, this needs Redis (or move to a proxy-layer
 * limiter on Cloudflare / nginx) so the bucket is shared.
 *
 * Tunable via env:
 *   RATE_LIMIT_UPLOADS_PER_MIN   — max uploads per minute per caller (default 20)
 *   RATE_LIMIT_BURST             — burst capacity (default = rate)
 */

const DEFAULT_RATE = Number(process.env.RATE_LIMIT_UPLOADS_PER_MIN) || 20;
const DEFAULT_BURST = Number(process.env.RATE_LIMIT_BURST) || DEFAULT_RATE;

function makeBucket(rate, burst) {
  return { tokens: burst, last: Date.now() };
}

function keyOf(req) {
  // Prefer the authenticated user id (so a shared NAT doesn't punish
  // multiple legitimate techs); fall back to remote address.
  const userId = req.user?.id || req.user?.sub;
  if (userId) return `u:${userId}`;
  return `ip:${req.ip || req.socket?.remoteAddress || 'unknown'}`;
}

function uploadLimiter({ rate = DEFAULT_RATE, burst = DEFAULT_BURST } = {}) {
  const buckets = new Map();
  const refillPerMs = rate / 60_000;

  // Periodic sweep so the map doesn't grow unbounded under a wide IP fan-out.
  // Drops buckets that have been full and idle for >10 minutes.
  const sweepInterval = setInterval(() => {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [k, b] of buckets) {
      if (b.tokens >= burst && b.last < cutoff) buckets.delete(k);
    }
  }, 60_000);
  sweepInterval.unref?.();

  return function rateLimit(req, res, next) {
    const k = keyOf(req);
    let b = buckets.get(k);
    if (!b) { b = makeBucket(rate, burst); buckets.set(k, b); }

    const now = Date.now();
    b.tokens = Math.min(burst, b.tokens + (now - b.last) * refillPerMs);
    b.last = now;

    if (b.tokens < 1) {
      const retryAfterSec = Math.ceil((1 - b.tokens) / refillPerMs / 1000);
      res.setHeader('Retry-After', String(retryAfterSec));
      res.setHeader('X-RateLimit-Limit', String(rate));
      res.setHeader('X-RateLimit-Remaining', '0');
      return res.status(429).json({
        error: 'rate_limited',
        message: `Too many uploads — retry in ${retryAfterSec}s`,
      });
    }

    b.tokens -= 1;
    res.setHeader('X-RateLimit-Limit', String(rate));
    res.setHeader('X-RateLimit-Remaining', String(Math.floor(b.tokens)));
    next();
  };
}

module.exports = { uploadLimiter };
