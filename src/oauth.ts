/**
 * Zoho Analytics MCP server — OAuth-gated Cloudflare Worker (for Claude.ai web).
 *
 * Same McpAgent + tools as the bearer worker (src/index.ts), but fronted by an
 * OAuth 2.1 provider (@cloudflare/workers-oauth-provider) so it can be added to
 * Claude.ai as a custom connector (Claude.ai web requires OAuth, not a bearer).
 *
 * Two consent modes (both show the requesting client and require an explicit
 * approval click before anything proceeds):
 *   - SINGLE-USER (default): a shared passphrase (APP_PASSPHRASE); the server
 *     calls Zoho with one worker-wide refresh token.
 *   - MULTI-USER (ZOHO_MULTI_USER=true): the approval click hands off to a real
 *     Zoho login (authorization-code flow); each user's own refresh token is
 *     stored in the encrypted OAuth grant props and the server acts as them.
 *
 * Routes:
 *   GET  /                         health check (no auth)
 *   GET/POST /authorize            consent screen (passphrase or Zoho-login)
 *   GET  /zoho/callback            multi-user: Zoho redirect back (this file)
 *   /token, /register, /.well-known/oauth-*   handled by OAuthProvider
 *   POST /mcp · GET /sse           MCP transports (OAuth-protected)
 *
 * Secrets (wrangler secret put ... -c wrangler.oauth.jsonc):
 *   ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET   Zoho OAuth app creds (server-based app
 *     with redirect <origin>/zoho/callback when multi-user)
 *   ZOHO_REFRESH_TOKEN   single-user only
 *   APP_PASSPHRASE       single-user only
 * Vars / optional: ZOHO_MULTI_USER, ZOHO_ORG_ID, ZOHO_DC, ZOHO_ACCESS_TOKEN,
 *   ZOHO_ANALYTICS_BASE_URL, ZOHO_ACCOUNTS_BASE_URL, ZOHO_MAX_RETRIES,
 *   MCP_READONLY, MCP_CORE
 */

import OAuthProvider from "@cloudflare/workers-oauth-provider";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ZohoAnalyticsClient, kvTokenStore, DC_DOMAINS, constantTimeEqual } from "./zohoanalytics.js";
import { registerTools, registerResourcesAndPrompts } from "./tools.js";

// Reuses the bearer worker's global Cloudflare.Env (MCP_OBJECT, ZOHO_*, etc.)
// and adds the OAuth-specific bindings.
interface Env extends Cloudflare.Env {
  OAUTH_KV: KVNamespace;
  /** Injected by OAuthProvider. */
  OAUTH_PROVIDER: OAuthHelpers;
  APP_PASSPHRASE: string;
  /**
   * "true" => MULTI-USER mode: the consent screen becomes a real Zoho login
   * (authorization-code flow). Each user's own Zoho refresh token is stored in
   * the encrypted OAuth grant props, so every action runs as — and is audited
   * to — that user. Requires a SERVER-BASED Zoho API client (Self Clients
   * cannot have redirect URIs) with redirect URI <origin>/zoho/callback, whose
   * id/secret go in ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET. When unset/false, the
   * single-user shared-passphrase consent is used.
   */
  ZOHO_MULTI_USER?: string;
}

type Props = { user: string; zohoRefreshToken?: string };
type AuthRequest = Awaited<ReturnType<OAuthHelpers["parseAuthRequest"]>>;

/** The MCP agent — identical tool surface to the bearer worker. */
export class ZohoAnalyticsMCP extends McpAgent<Env, unknown, Props> {
  server = new McpServer({ name: "zoho-analytics", version: "1.6.2" });

  async init(): Promise<void> {
    // Multi-user grants carry the user's own refresh token in (encrypted) props;
    // single-user grants fall back to the worker-wide secret.
    const props = this.props as Props | undefined;
    const userRefreshToken = props?.zohoRefreshToken;
    const refreshToken = userRefreshToken ?? this.env.ZOHO_REFRESH_TOKEN;
    const accessToken = userRefreshToken ? undefined : this.env.ZOHO_ACCESS_TOKEN;

    // A grant with no usable credentials (e.g. a stale passphrase grant in a
    // multi-user-only deployment) must not 500 the session — register an empty,
    // explanatory surface instead.
    const hasCreds = !!accessToken || !!(refreshToken && this.env.ZOHO_CLIENT_ID && this.env.ZOHO_CLIENT_SECRET);
    if (!hasCreds) {
      this.server.registerTool(
        "zoho_reauthorize_required",
        {
          description: "This connection has no usable Zoho credentials. Remove and re-add the connector to sign in again.",
          inputSchema: {},
          annotations: { title: "Re-authorize required", readOnlyHint: true, openWorldHint: false },
        },
        async () => ({
          content: [{ type: "text", text: "No Zoho credentials for this grant. Reconnect the connector (Settings → Connectors)." }],
          isError: true,
        }),
      );
      return;
    }

    // Per-user cache namespace: in multi-user mode the schema cache MUST be keyed
    // per grant, or one user's describe-workspace result would be served to
    // another whose Zoho identity lacks access to that workspace.
    const cachePrefix = userRefreshToken ? `u:${props?.user ?? "grant"}:` : "";
    const client = new ZohoAnalyticsClient({
      clientId: this.env.ZOHO_CLIENT_ID,
      clientSecret: this.env.ZOHO_CLIENT_SECRET,
      refreshToken,
      accessToken,
      orgId: this.env.ZOHO_ORG_ID,
      dc: this.env.ZOHO_DC,
      analyticsBaseUrl: this.env.ZOHO_ANALYTICS_BASE_URL,
      accountsBaseUrl: this.env.ZOHO_ACCOUNTS_BASE_URL,
      maxRetries: this.env.ZOHO_MAX_RETRIES ? Number(this.env.ZOHO_MAX_RETRIES) : undefined,
      // Cached access tokens are namespaced per grant in multi-user mode —
      // users must never share access tokens. Zoho caps mints ~10/10min/token.
      tokenStore: kvTokenStore(this.env.OAUTH_KV, userRefreshToken ? (props?.user ?? "grant") : ""),
    });
    registerTools(this.server, client, {
      orgId: this.env.ZOHO_ORG_ID,
      dc: this.env.ZOHO_DC ?? "com",
      readOnly: this.env.MCP_READONLY === "true",
      core: this.env.MCP_CORE === "true",
      cache: {
        get: (key) => this.env.OAUTH_KV.get(cachePrefix + key),
        put: (key, value, ttlSecs) => this.env.OAUTH_KV.put(cachePrefix + key, value, { expirationTtl: Math.max(60, ttlSecs) }),
      },
    });
    registerResourcesAndPrompts(this.server, client);
  }
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

/**
 * Render the consent screen. mode="passphrase" (single-user) shows a passphrase
 * field; mode="zoho" (multi-user) shows a "Continue to Zoho sign-in" button —
 * the click is the explicit per-client approval that prevents a confused-deputy
 * grant (an attacker-registered MCP client cannot silently capture a victim's
 * Zoho grant, because the victim sees WHICH client is asking and must consent).
 */
function consentPage(
  reqInfo: AuthRequest,
  clientName: string,
  error: string | null,
  mode: "passphrase" | "zoho" = "passphrase",
): Response {
  const req = b64encodeUtf8(JSON.stringify(reqInfo));
  const field =
    mode === "zoho"
      ? ""
      : `<label for="p">Passphrase</label>
    <input id="p" name="passphrase" type="password" autocomplete="current-password" autofocus required>`;
  const buttonText = mode === "zoho" ? "Continue to Zoho sign-in" : "Authorize";
  const foot =
    mode === "zoho"
      ? "You'll sign in with your own Zoho account · this app will act as you"
      : "Single-user connector · enter your passphrase to continue";
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
    ${field}
    <input type="hidden" name="req" value="${req}">
    <button type="submit">${buttonText}</button>
    ${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
    <p class="foot">${foot}</p>
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

// ---- Multi-user mode: real Zoho login on consent ----

const multiUserEnabled = (env: Env): boolean =>
  env.ZOHO_MULTI_USER === "true" && !!env.ZOHO_CLIENT_ID && !!env.ZOHO_CLIENT_SECRET;

function zohoAccountsOrigin(env: Env): string {
  if (env.ZOHO_ACCOUNTS_BASE_URL) return env.ZOHO_ACCOUNTS_BASE_URL.replace(/\/+$/, "");
  const dc = (env.ZOHO_DC ?? "com").toLowerCase();
  return `https://${(DC_DOMAINS[dc] ?? DC_DOMAINS.com).accounts}`;
}

/** Multi-user: park the MCP auth request in KV and send the user to Zoho's login/consent. */
async function startZohoLogin(reqInfo: AuthRequest, request: Request, env: Env): Promise<Response> {
  const state = crypto.randomUUID();
  await env.OAUTH_KV.put(`authreq:${state}`, JSON.stringify(reqInfo), { expirationTtl: 600 });
  const redirectUri = `${new URL(request.url).origin}/zoho/callback`;
  const auth = new URL(`${zohoAccountsOrigin(env)}/oauth/v2/auth`);
  auth.searchParams.set("scope", "ZohoAnalytics.fullaccess.all");
  auth.searchParams.set("client_id", env.ZOHO_CLIENT_ID!);
  auth.searchParams.set("response_type", "code");
  auth.searchParams.set("access_type", "offline");
  auth.searchParams.set("prompt", "consent"); // ensures a refresh_token on every grant
  auth.searchParams.set("redirect_uri", redirectUri);
  auth.searchParams.set("state", state);
  return Response.redirect(auth.toString(), 302);
}

/** Multi-user: Zoho redirected back — exchange the code and finish the MCP grant. */
async function handleZohoCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state") ?? "";
  const stored = state ? await env.OAUTH_KV.get(`authreq:${state}`) : null;
  if (!code || !stored) return new Response("Login expired or invalid — retry connecting.", { status: 400 });
  await env.OAUTH_KV.delete(`authreq:${state}`);
  const reqInfo = JSON.parse(stored) as AuthRequest;

  // Exchange at Zoho (credentials in the POST body, never the URL).
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: env.ZOHO_CLIENT_ID!,
    client_secret: env.ZOHO_CLIENT_SECRET!,
    redirect_uri: `${url.origin}/zoho/callback`,
    code,
  });
  const res = await fetch(`${zohoAccountsOrigin(env)}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const data = (await res.json().catch(() => ({}))) as { refresh_token?: string; error?: string };
  if (!data.refresh_token) {
    return new Response(`Zoho login failed: ${data.error ?? `HTTP ${res.status}`}. Retry connecting.`, { status: 502 });
  }

  const user = crypto.randomUUID();
  try {
    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: reqInfo,
      userId: user,
      metadata: {},
      scope: reqInfo.scope ?? [],
      // Props are stored encrypted by the OAuth provider — the user's refresh
      // token never appears in plaintext KV.
      props: { user, zohoRefreshToken: data.refresh_token } satisfies Props,
    });
    return Response.redirect(redirectTo, 302);
  } catch {
    // The MCP auth request expired/was tampered between login start and callback.
    return new Response("Authorization could not be completed — retry connecting.", { status: 400 });
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
    // Both modes show a consent screen first (displaying the requesting client),
    // so the user explicitly approves THIS client before anything proceeds.
    return consentPage(reqInfo, await clientName(env, reqInfo.clientId), null, multiUserEnabled(env) ? "zoho" : "passphrase");
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

    // Multi-user: the consent POST IS the per-client approval — now hand off to
    // Zoho's own login. The passphrase path below is never reachable in this
    // mode, so a shared secret can't bypass the per-user Zoho login.
    if (multiUserEnabled(env)) return startZohoLogin(reqInfo, request, env);

    const ip = clientIp(request);
    if (await isLockedOut(env, ip)) {
      return new Response("Too many failed attempts. Try again later.", {
        status: 429,
        headers: { "retry-after": String(WINDOW_SECS) },
      });
    }

    // Fail closed: no passphrase configured -> reject everything.
    if (!env.APP_PASSPHRASE || !constantTimeEqual(passphrase, env.APP_PASSPHRASE)) {
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
    if (url.pathname === "/zoho/callback" && multiUserEnabled(env)) return handleZohoCallback(request, env);
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
