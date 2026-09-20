// Small in-memory fixed-window limiter. Good enough to blunt password guessing and sign-up spam on this
// single-process deployment; the counters reset when the service restarts.
type Bucket = { count: number; resetAt: number };

export function createLimiter(max: number, windowMs: number) {
  const buckets = new Map<string, Bucket>();

  const sweep = (now: number) => {
    if (buckets.size < 5_000) return;
    for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key);
  };

  return {
    /** Seconds until the key may try again, or 0 if it is not blocked. */
    blockedFor(key: string): number {
      const bucket = buckets.get(key);
      const now = Date.now();
      if (!bucket || bucket.resetAt <= now || bucket.count < max) return 0;
      return Math.ceil((bucket.resetAt - now) / 1000);
    },
    /** Record one (failed) attempt. */
    hit(key: string): void {
      const now = Date.now();
      sweep(now);
      const bucket = buckets.get(key);
      if (!bucket || bucket.resetAt <= now) buckets.set(key, { count: 1, resetAt: now + windowMs });
      else bucket.count += 1;
    },
    reset(key: string): void {
      buckets.delete(key);
    },
  };
}

// Caddy overwrites/appends X-Forwarded-For with the real peer address, so the last entry is the one
// the proxy saw; earlier entries can be forged by the client.
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const last = forwarded
    ?.split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .pop();
  return last || request.headers.get("x-real-ip") || "local";
}

// 10 failed sign-ins per IP per 15 minutes; 5 sign-up attempts per IP per hour.
export const loginLimiter = createLimiter(10, 15 * 60 * 1000);
export const signupLimiter = createLimiter(5, 60 * 60 * 1000);
