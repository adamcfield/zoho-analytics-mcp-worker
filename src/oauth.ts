/**
 * Zoho Analytics MCP server — OAuth-gated Cloudflare Worker (for Claude.ai web).
 *
 * Same McpAgent + tools as the bearer worker (src/index.ts), but fronted by an
 * OAuth 2.1 provider (@cloudflare/workers-oauth-provider) so it can be added to
 * Claude.ai as a custom connector (Claude.ai web requires OAuth, not a bearer).
 *
 * Access is gated by a single shared passphrase (APP_PASSPHRASE) entered on the
 * consent screen — single-user by design. (This is the connector login; it is
 * separate from the Zoho OAuth credentials the server uses to call the API.)
 *
 * Routes:
 *   GET  /                         health check (no auth)
 *   GET/POST /authorize            passphrase consent screen   (this file)
 *   /token, /register, /.well-known/oauth-*   handled by OAuthProvider
 *   POST /mcp · GET /sse           MCP transports (OAuth-protected)
 *
 * Secrets (wrangler secret put ... -c wrangler.oauth.jsonc):
 *   ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN   Zoho OAuth app creds
 *   APP_PASSPHRASE     passphrase that authorizes the connector
 * Vars / optional: ZOHO_ORG_ID, ZOHO_DC, ZOHO_ACCESS_TOKEN,
 *   ZOHO_ANALYTICS_BASE_URL, ZOHO_ACCOUNTS_BASE_URL, ZOHO_MAX_RETRIES, MCP_READONLY
 */

import OAuthProvider from "@cloudflare/workers-oauth-provider";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ZohoAnalyticsClient, kvTokenStore } from "./zohoanalytics.js";
import { registerTools } from "./tools.js";

// Reuses the bearer worker's global Cloudflare.Env (MCP_OBJECT, ZOHO_*, etc.)
// and adds the OAuth-specific bindings.
interface Env extends Cloudflare.Env {
  OAUTH_KV: KVNamespace;
  /** Injected by OAuthProvider. */
  OAUTH_PROVIDER: OAuthHelpers;
  APP_PASSPHRASE: string;
}

type Props = { user: string };
type AuthRequest = Awaited<ReturnType<OAuthHelpers["parseAuthRequest"]>>;

/** The MCP agent — identical tool surface to the bearer worker. */
export class ZohoAnalyticsMCP extends McpAgent<Env, unknown, Props> {
  server = new McpServer({ name: "zoho-analytics", version: "1.5.1" });

  async init(): Promise<void> {
    const client = new ZohoAnalyticsClient({
      clientId: this.env.ZOHO_CLIENT_ID,
      clientSecret: this.env.ZOHO_CLIENT_SECRET,
      refreshToken: this.env.ZOHO_REFRESH_TOKEN,
      accessToken: this.env.ZOHO_ACCESS_TOKEN,
      orgId: this.env.ZOHO_ORG_ID,
      dc: this.env.ZOHO_DC,
      analyticsBaseUrl: this.env.ZOHO_ANALYTICS_BASE_URL,
      accountsBaseUrl: this.env.ZOHO_ACCOUNTS_BASE_URL,
      maxRetries: this.env.ZOHO_MAX_RETRIES ? Number(this.env.ZOHO_MAX_RETRIES) : undefined,
      // Share one Zoho access token across all sessions via the OAuth KV —
      // Zoho caps token creation (~10 per 10 min per refresh token).
      tokenStore: kvTokenStore(this.env.OAUTH_KV),
    });
    registerTools(this.server, client, {
      orgId: this.env.ZOHO_ORG_ID,
      dc: this.env.ZOHO_DC ?? "com",
      readOnly: this.env.MCP_READONLY === "true",
    });
  }
}

/** Length-safe constant-time string comparison. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

/** UTF-8-safe base64 round-trip (btoa alone throws on code points > 0xFF, e.g. a unicode OAuth `state`). */
function b64encodeUtf8(s: string): string {
  // Chunked: spreading a large byte array into fromCharCode overflows the
  // argument/stack limit (~125KB) — an attacker-sized `state` must not 500.
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}
function b64decodeUtf8(b64: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}

/** Render the single-user passphrase consent screen. */
function consentPage(reqInfo: AuthRequest, clientName: string, error: string | null): Response {
  const req = b64encodeUtf8(JSON.stringify(reqInfo));
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize Zoho Analytics MCP</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { font: 16px/1.5 system-ui, -apple-system, sans-serif; margin: 0; display: grid; place-items: center; min-height: 100vh; background: #0b0c0f; color: #e7e9ee; }
  .card { width: min(92vw, 380px); background: #15171c; border: 1px solid #272a31; border-radius: 14px; padding: 28px; box-shadow: 0 10px 40px rgba(0,0,0,.45); }
  h1 { font-size: 18px; margin: 0 0 6px; }
  p { color: #9aa0aa; font-size: 14px; margin: 0 0 18px; }
  .client { color: #e7e9ee; font-weight: 600; }
  label { display: block; font-size: 13px; margin: 0 0 6px; color: #c2c7d0; }
  input[type=password] { width: 100%; padding: 11px 12px; border-radius: 9px; border: 1px solid #303440; background: #0e1014; color: #fff; font-size: 15px; }
  button { width: 100%; margin-top: 16px; padding: 11px; border: 0; border-radius: 9px; background: #4c6ef5; color: #fff; font-size: 15px; font-weight: 600; cursor: pointer; }
  button:hover { background: #3b5bdb; }
  .err { color: #ff8787; font-size: 13px; margin: 12px 0 0; }
  .foot { color: #6b7280; font-size: 12px; margin-top: 18px; text-align: center; }
</style></head>
<body>
  <form class="card" method="POST" action="/authorize">
    <h1>Authorize access</h1>
    <p><span class="client">${escapeHtml(clientName || "An application")}</span> wants to connect to your Zoho Analytics MCP server.</p>
    <label for="p">Passphrase</label>
    <input id="p" name="passphrase" type="password" autocomplete="current-password" autofocus required>
    <input type="hidden" name="req" value="${req}">
    <button type="submit">Authorize</button>
    ${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
    <p class="foot">Single-user connector · enter your passphrase to continue</p>
  </form>
</body></html>`;
  return new Response(html, {
    status: error ? 401 : 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

/** Best-effort human-readable client name for the consent screen. */
async function clientName(env: Env, clientId: string): Promise<string> {
  try {
    const client = await env.OAUTH_PROVIDER.lookupClient(clientId);
    return (client as { clientName?: string } | null)?.clientName ?? "";
  } catch {
    return "";
  }
}

// ---- Passphrase brute-force lockout (KV-backed, per client IP) ----
// /authorize is public and the passphrase is the sole auth factor, so failed
// attempts are throttled: MAX_ATTEMPTS failures within WINDOW_SECS locks that
// IP out until the window expires. KV is eventually consistent (~60s), which is
// fine for a coarse lockout — the goal is stopping brute force, not exactness.
const MAX_ATTEMPTS = 10;
const WINDOW_SECS = 900;

function clientIp(request: Request): string {
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

async function isLockedOut(env: Env, ip: string): Promise<boolean> {
  try {
    return Number((await env.OAUTH_KV.get(`authfail:${ip}`)) ?? 0) >= MAX_ATTEMPTS;
  } catch {
    return false; // a KV outage must not lock everyone out
  }
}

async function recordFailedAttempt(env: Env, ip: string): Promise<void> {
  try {
    const key = `authfail:${ip}`;
    const n = Number((await env.OAUTH_KV.get(key)) ?? 0) + 1;
    await env.OAUTH_KV.put(key, String(n), { expirationTtl: WINDOW_SECS });
  } catch {
    /* best-effort */
  }
}

async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  if (request.method === "GET") {
    let reqInfo: AuthRequest;
    try {
      reqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(request);
    } catch {
      return new Response("Invalid OAuth request", { status: 400 });
    }
    if (!reqInfo.clientId) return new Response("Invalid OAuth request", { status: 400 });
    return consentPage(reqInfo, await clientName(env, reqInfo.clientId), null);
  }

  if (request.method === "POST") {
    let reqInfo: AuthRequest;
    let passphrase: string;
    try {
      const form = await request.formData();
      passphrase = String(form.get("passphrase") ?? "");
      reqInfo = JSON.parse(b64decodeUtf8(String(form.get("req") ?? ""))) as AuthRequest;
    } catch {
      return new Response("Invalid OAuth request", { status: 400 });
    }
    if (!reqInfo.clientId) return new Response("Invalid OAuth request", { status: 400 });

    const ip = clientIp(request);
    if (await isLockedOut(env, ip)) {
      return new Response("Too many failed attempts. Try again later.", {
        status: 429,
        headers: { "retry-after": String(WINDOW_SECS) },
      });
    }

    // Fail closed: no passphrase configured -> reject everything.
    if (!env.APP_PASSPHRASE || !safeEqual(passphrase, env.APP_PASSPHRASE)) {
      await recordFailedAttempt(env, ip);
      return consentPage(reqInfo, await clientName(env, reqInfo.clientId), "Incorrect passphrase. Try again.");
    }

    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: reqInfo,
      userId: "owner",
      metadata: {},
      scope: reqInfo.scope ?? [],
      props: { user: "owner" } satisfies Props,
    });
    return Response.redirect(redirectTo, 302);
  }

  return new Response("Method not allowed", { status: 405 });
}

/** Non-API, non-token routes: the consent screen and a public health check. */
const defaultHandler = {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/authorize") return handleAuthorize(request, env);
    if (url.pathname === "/" && request.method === "GET") {
      return new Response("zoho-analytics-mcp-oauth worker: ok (OAuth-gated MCP at /mcp)", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    }
    return new Response("Not found", { status: 404 });
  },
};

export default new OAuthProvider({
  apiHandlers: {
    "/mcp": ZohoAnalyticsMCP.serve("/mcp"),
    "/sse": ZohoAnalyticsMCP.serveSSE("/sse"),
  },
  defaultHandler: defaultHandler as never,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});
