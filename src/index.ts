/**
 * Zoho Analytics MCP server — Cloudflare Worker (remote, Streamable-HTTP + SSE).
 *
 * The Zoho OAuth credentials live as Worker secrets; access to the MCP endpoint
 * is gated by a bearer token (MCP_AUTH_TOKEN) so a leaked URL isn't an open
 * relay to your Analytics org.
 *
 * Endpoints:
 *   GET  /            -> public health check (no auth)
 *   GET  /health      -> JSON health { ok, version, warnings[] } (no auth)
 *   POST /mcp         -> MCP Streamable HTTP   (bearer required)
 *   GET  /sse         -> MCP SSE (legacy)      (bearer required)
 *
 * Secrets (wrangler secret put ...):
 *   ZOHO_CLIENT_ID       OAuth client id
 *   ZOHO_CLIENT_SECRET   OAuth client secret
 *   ZOHO_REFRESH_TOKEN   long-lived refresh token (access_type=offline)
 *   MCP_AUTH_TOKEN       shared secret clients send as `Authorization: Bearer <...>`
 * Vars (wrangler.jsonc [vars] or secrets):
 *   ZOHO_ORG_ID          ZANALYTICS-ORGID (get it from zoho_get_orgs)
 *   ZOHO_DC              data center: com | eu | in | au | jp | sa | ca | uk | cn (default com)
 * Optional:
 *   ZOHO_ACCESS_TOKEN    static access token (expires hourly; testing only — skips refresh)
 *   ZOHO_ANALYTICS_BASE_URL, ZOHO_ACCOUNTS_BASE_URL   explicit endpoint overrides
 *   ZOHO_MAX_RETRIES     transient-retry attempts for GETs (default 3)
 *   MCP_READONLY         "true" => register read-only tools only (no add/update/delete/import/create)
 */

import { serverIcons } from "./server-icon.js";
import { BRAND } from "./ui.js";
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ZohoAnalyticsClient, kvTokenStore, signDownloadToken, verifyDownloadToken, constantTimeEqual } from "./zohoanalytics.js";
import { VERSION, MCP_INSTRUCTIONS } from "./version.js";
import { healthBody, healthResponse } from "./health.js";
import { registerTools, registerResourcesAndPrompts, type RegisterToolsOptions } from "./tools.js";
import { readHeaderCredential, sameCredential, credentialId, maskClientId, type HeaderCredential } from "./byo-headers.js";
import type { TokenStore } from "./zohoanalytics.js";

/** Workers Rate Limiting binding (open beta) — structural type. */
interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

declare global {
  namespace Cloudflare {
    interface Env {
      MCP_OBJECT: DurableObjectNamespace;
      ZOHO_CLIENT_ID?: string;
      ZOHO_CLIENT_SECRET?: string;
      ZOHO_REFRESH_TOKEN?: string;
      ZOHO_ACCESS_TOKEN?: string;
      ZOHO_ORG_ID?: string;
      ZOHO_DC?: string;
      ZOHO_ANALYTICS_BASE_URL?: string;
      ZOHO_ACCOUNTS_BASE_URL?: string;
      ZOHO_MAX_RETRIES?: string;
      MCP_AUTH_TOKEN: string;
      /** "true" => register read-only tools only. */
      MCP_READONLY?: string;
      /**
       * Optional KV namespace for sharing one Zoho access token across all MCP
       * sessions. Strongly recommended in production: each session is its own
       * Durable Object, and without a shared cache every new session mints its
       * own token — Zoho caps token creation at ~10 per 10 min per refresh
       * token. Create with `wrangler kv namespace create TOKEN_KV` and add a
       * kv_namespaces entry to wrangler.jsonc. Also backs the short-TTL schema
       * cache (describe-workspace).
       */
      TOKEN_KV?: KVNamespace;
      /** "true" => register only the curated ~26 everyday tools (better tool selection for daily LLM use). */
      MCP_CORE?: string;
      /** Optional R2 bucket: oversized export results spill here and come back as signed URLs. */
      EXPORTS?: R2Bucket;
      /** Public origin of this worker (for building signed /download URLs). */
      PUBLIC_BASE_URL?: string;
      /** Optional Workers Analytics Engine dataset: per-tool usage telemetry. */
      USAGE?: AnalyticsEngineDataset;
      /** Optional Workers rate-limiter: per-IP request flood cap (auth brute force is already infeasible). */
      RATE_LIMITER?: unknown;
      /** "false" (exact) => refuse caller-supplied Zoho clients in X-Zoho-* headers. */
      MCP_BYO_KEYS?: string;
    }
  }
}
type Env = Cloudflare.Env;

/** Build a configured client from the Worker environment. */
export function clientFromEnv(env: Env): ZohoAnalyticsClient {
  return new ZohoAnalyticsClient({
    clientId: env.ZOHO_CLIENT_ID,
    clientSecret: env.ZOHO_CLIENT_SECRET,
    refreshToken: env.ZOHO_REFRESH_TOKEN,
    accessToken: env.ZOHO_ACCESS_TOKEN,
    orgId: env.ZOHO_ORG_ID,
    dc: env.ZOHO_DC,
    analyticsBaseUrl: env.ZOHO_ANALYTICS_BASE_URL,
    accountsBaseUrl: env.ZOHO_ACCOUNTS_BASE_URL,
    maxRetries: env.ZOHO_MAX_RETRIES ? Number(env.ZOHO_MAX_RETRIES) : undefined,
    tokenStore: env.TOKEN_KV ? kvTokenStore(env.TOKEN_KV) : undefined,
  });
}

/** Optional integrations resolved from the environment (all degrade to undefined). */
export function integrationsFromEnv(env: Env): Pick<RegisterToolsOptions, "track" | "cache" | "exportStore"> {
  const track = env.USAGE
    ? (tool: string, ok: boolean) => {
        env.USAGE!.writeDataPoint({ blobs: [tool, ok ? "ok" : "error"], doubles: [1], indexes: [tool] });
      }
    : undefined;
  const cache = env.TOKEN_KV
    ? {
        get: (key: string) => env.TOKEN_KV!.get(key),
        put: (key: string, value: string, ttlSecs: number) =>
          env.TOKEN_KV!.put(key, value, { expirationTtl: Math.max(60, ttlSecs) }),
      }
    : undefined;
  const exportStore =
    env.EXPORTS && env.PUBLIC_BASE_URL && env.MCP_AUTH_TOKEN
      ? {
          save: async (body: string, contentType: string) => {
            const key = `exp/${crypto.randomUUID()}`;
            await env.EXPORTS!.put(key, body, { httpMetadata: { contentType } });
            const exp = Math.floor(Date.now() / 1000) + 24 * 3600;
            const sig = await signDownloadToken(key, exp, env.MCP_AUTH_TOKEN);
            return {
              url: `${env.PUBLIC_BASE_URL!.replace(/\/+$/, "")}/download/${key}?exp=${exp}&sig=${sig}`,
              expires_at: new Date(exp * 1000).toISOString(),
            };
          },
        }
      : undefined;
  return { track, cache, exportStore };
}

/** Session props: the caller's own Zoho client from X-Zoho-* headers, or {} (the worker's own). */
type HeaderProps = Partial<HeaderCredential>;

/** Token store for one header credential: keyed by a hash of client id + refresh token, never shared. */
function headerTokenStore(kv: KVNamespace | undefined, cred: HeaderCredential): TokenStore | undefined {
  if (!kv) return undefined;
  const store = (async () => kvTokenStore(kv, `byo:${await credentialId(cred)}`))();
  return {
    get: async () => (await store).get(),
    set: async (token, expiry) => (await store).set(token, expiry),
  };
}

/** A client built from the caller's own Zoho client; never the worker's ZOHO_* secrets, URL overrides or cache. */
export function clientFromHeaders(cred: HeaderCredential, env: Env): ZohoAnalyticsClient {
  return new ZohoAnalyticsClient({
    clientId: cred.cid,
    clientSecret: cred.cs,
    refreshToken: cred.rt,
    orgId: cred.org,
    dc: cred.dc,
    maxRetries: env.ZOHO_MAX_RETRIES ? Number(env.ZOHO_MAX_RETRIES) : undefined,
    tokenStore: headerTokenStore(env.TOKEN_KV, cred),
  });
}

const isHeaderCred = (p: HeaderProps): p is HeaderCredential => !!(p.cid && p.cs && p.rt && p.dc);

export class ZohoAnalyticsMCP extends McpAgent<Env, unknown, HeaderProps> {
  server = new McpServer({ name: "zoho-analytics", version: VERSION, icons: serverIcons(BRAND.logo) }, { instructions: MCP_INSTRUCTIONS });
  private cached?: { key: HeaderProps; client: ZohoAnalyticsClient };

  /** The client for the credential on THIS request (props follow each request). */
  private current(): ZohoAnalyticsClient {
    const p = this.props ?? {};
    if (this.cached && sameCredential(this.cached.key, p)) return this.cached.client;
    const client = isHeaderCred(p) ? clientFromHeaders(p, this.env) : clientFromEnv(this.env);
    this.cached = { key: { ...p }, client };
    return client;
  }

  async init(): Promise<void> {
    // Tools hold a forwarding client, so a credential change between requests of one session
    // takes effect at once and one caller's client is never lent to another.
    const forward = new Proxy({} as ZohoAnalyticsClient, {
      get: (_t, k) => {
        const c = this.current() as unknown as Record<string | symbol, unknown>;
        const v = c[k];
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(c) : v;
      },
    });
    const self = this;
    const own = () => {
      const p = self.props ?? {};
      return isHeaderCred(p) ? p : undefined;
    };
    const integrations = integrationsFromEnv(this.env);
    // The schema cache is per credential too: one caller's workspace list is never served to another.
    const kv = this.env.TOKEN_KV;
    const cache = kv
      ? {
          prefix: async () => {
            const p = own();
            return p ? `byo:${await credentialId(p)}:` : "";
          },
          get: async (key: string) => kv.get((await cache!.prefix()) + key),
          put: async (key: string, value: string, ttlSecs: number) =>
            kv.put((await cache!.prefix()) + key, value, { expirationTtl: Math.max(60, ttlSecs) }),
        }
      : undefined;
    registerTools(this.server, forward, {
      // Getters: zoho_whoami reports the credential on the current request.
      get orgId() {
        const p = own();
        return p ? p.org : self.env.ZOHO_ORG_ID;
      },
      get dc() {
        const p = own();
        return p ? p.dc : (self.env.ZOHO_DC ?? "com");
      },
      get credential() {
        const p = own();
        return p ? { source: "own_client_header", clientId: maskClientId(p.cid) } : { source: "server" };
      },
      readOnly: this.env.MCP_READONLY === "true",
      core: this.env.MCP_CORE === "true",
      ...integrations,
      cache: cache ? { get: cache.get, put: cache.put } : undefined,
    });
    registerResourcesAndPrompts(this.server, forward);
  }

  // agents hands every request's props to this hook, but onStart only stores the first. Replace
  // the session's props whenever the presented credential differs, including back to {} for the
  // worker's own, so the client in use is always the one on THIS request. Internal API: re-check
  // on agents upgrades (tests/byo-headers.test.ts guards it).
  override async __unsafe_ensureInitialized(props?: HeaderProps): Promise<void> {
    await super.__unsafe_ensureInitialized(props);
    const next = props ?? {};
    if (!sameCredential(next, this.props)) await this.updateProps(next);
  }
}

function authorized(request: Request, env: Env): boolean {
  // Fail closed: if no secret is configured, reject everything.
  if (!env.MCP_AUTH_TOKEN) return false;
  const header = request.headers.get("authorization") ?? "";
  // RFC 7235: the auth-scheme is case-insensitive.
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return false;
  return constantTimeEqual(match[1], env.MCP_AUTH_TOKEN);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Per-IP flood cap (when the rate-limiter binding is configured). The bearer
    // token is brute-force-infeasible; this bounds request-volume cost instead.
    const limiter = env.RATE_LIMITER as RateLimit | undefined;
    if (limiter && typeof limiter.limit === "function") {
      try {
        const { success } = await limiter.limit({ key: request.headers.get("cf-connecting-ip") ?? "unknown" });
        if (!success) {
          return new Response("Rate limited. Slow down.", { status: 429, headers: { "retry-after": "60" } });
        }
      } catch {
        /* a limiter outage must not take the API down */
      }
    }

    // Public, unauthenticated health check.
    if (request.method === "GET" && url.pathname === "/") {
      return new Response("zoho-analytics-mcp worker: ok", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    }

    // Structured health (no auth, no secret values): { ok, version, warnings[] }.
    if (request.method === "GET" && url.pathname === "/health") {
      const byo = env.MCP_BYO_KEYS !== "false";
      const gate = env.MCP_AUTH_TOKEN || byo ? [] : ["MCP_AUTH_TOKEN not set (every MCP call returns 401)"];
      return healthResponse(healthBody(env, "bearer", gate, { ownClients: byo }));
    }

    // Signed export downloads (capability URL — the HMAC in the query IS the auth).
    if (request.method === "GET" && url.pathname.startsWith("/download/") && env.EXPORTS && env.MCP_AUTH_TOKEN) {
      let key: string;
      try {
        key = decodeURIComponent(url.pathname.slice("/download/".length));
      } catch {
        return new Response("Invalid download link", { status: 400 }); // malformed %-encoding
      }
      const exp = Number(url.searchParams.get("exp"));
      const sig = url.searchParams.get("sig") ?? "";
      if (!key.startsWith("exp/") || !(await verifyDownloadToken(key, exp, sig, env.MCP_AUTH_TOKEN))) {
        return new Response("Invalid or expired download link", { status: 403 });
      }
      const obj = await env.EXPORTS.get(key);
      if (!obj) return new Response("Export not found (expired)", { status: 404 });
      return new Response(obj.body, {
        status: 200,
        headers: {
          "content-type": obj.httpMetadata?.contentType ?? "application/octet-stream",
          // Org data behind a capability URL: don't let browsers cache it past
          // link expiry, and don't let the browser sniff a different type.
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
      });
    }

    // The caller's own Zoho client (X-Zoho-* headers) authenticates them with Zoho; otherwise the
    // bearer gate protects the worker's own Zoho credential.
    const own = readHeaderCredential(request.headers, env);
    if (own && !own.ok) return Response.json({ error: own.error }, { status: 400 });
    if (!own && !authorized(request, env)) {
      return new Response("Unauthorized", {
        status: 401,
        headers: { "www-authenticate": "Bearer" },
      });
    }

    // Deployed-but-unconfigured guard: without Zoho credentials the client
    // constructor would throw inside the Durable Object (an opaque 1101).
    // Surface the actual problem to the (already-authenticated) caller instead.
    const hasZohoCreds =
      !!own || !!env.ZOHO_ACCESS_TOKEN || !!(env.ZOHO_REFRESH_TOKEN && env.ZOHO_CLIENT_ID && env.ZOHO_CLIENT_SECRET);
    if (!hasZohoCreds) {
      return new Response(
        "Zoho credentials not configured. Send your own Zoho client in X-Zoho-Client-Id / X-Zoho-Client-Secret / X-Zoho-Refresh-Token, or set the ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET and ZOHO_REFRESH_TOKEN secrets — see the README.",
        { status: 503 },
      );
    }

    const props: HeaderProps = own?.ok ? own.cred : {};
    const sctx = {
      waitUntil: ctx.waitUntil.bind(ctx),
      passThroughOnException: ctx.passThroughOnException.bind(ctx),
      props,
    } as unknown as ExecutionContext;

    if (url.pathname === "/mcp") {
      return ZohoAnalyticsMCP.serve("/mcp").fetch(request, env, sctx);
    }
    if (url.pathname === "/sse" || url.pathname === "/sse/message") {
      return ZohoAnalyticsMCP.serveSSE("/sse").fetch(request, env, sctx);
    }
    return new Response("Not found", { status: 404 });
  },
};
