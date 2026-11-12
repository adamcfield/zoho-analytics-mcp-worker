/**
 * Failed-attempt throttle for the public pages (/authorize passphrase, own-client codes, /managed).
 * KV-backed, per client IP: MAX_ATTEMPTS failures within WINDOW_SECS lock that IP out until the
 * window expires. KV is eventually consistent (~60 s), which is fine for a coarse lockout.
 */
export const MAX_ATTEMPTS = 10;
export const WINDOW_SECS = 900;

export function clientIp(request: Request): string {
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  // Bucket IPv6 by /64: an attacker's standard allocation is a whole /64, so
  // per-address buckets would make the lockout trivially bypassable.
  if (ip.includes(":")) {
    const [head, tail = ""] = ip.split("::");
    const headGroups = head ? head.split(":") : [];
    const tailGroups = tail ? tail.split(":") : [];
    const zeros = Array(Math.max(0, 8 - headGroups.length - tailGroups.length)).fill("0");
    const full = [...headGroups, ...zeros, ...tailGroups];
    return `${full.slice(0, 4).join(":")}::/64`;
  }
  return ip;
}

export async function isLockedOut(kv: KVNamespace, ip: string): Promise<boolean> {
  try {
    return Number((await kv.get(`authfail:${ip}`)) ?? 0) >= MAX_ATTEMPTS;
  } catch {
    return false; // a KV outage must not lock everyone out
  }
}

export async function recordFailedAttempt(kv: KVNamespace, ip: string): Promise<void> {
  try {
    const key = `authfail:${ip}`;
    const n = Number((await kv.get(key)) ?? 0) + 1;
    await kv.put(key, String(n), { expirationTtl: WINDOW_SECS });
  } catch {
    /* best-effort */
  }
}
