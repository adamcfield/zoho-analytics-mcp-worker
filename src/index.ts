/**
 * Zoho Analytics MCP server — Cloudflare Worker (remote, Streamable-HTTP + SSE).
 *
 * The Zoho OAuth credentials live as Worker secrets; access to the MCP endpoint
 * is gated by a bearer token (MCP_AUTH_TOKEN) so a leaked URL isn't an open
 * relay to your Analytics org.
 *
 * Endpoints:
 *   GET  /            -> public health check (no auth)
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

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ZohoAnalyticsClient, kvTokenStore, signDownloadToken, verifyDownloadToken } from "./zohoanalytics.js";
import { registerTools, registerResourcesAndPrompts, type RegisterToolsOptions } from "./tools.js";

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

export class ZohoAnalyticsMCP extends McpAgent<Env> {
  server = new McpServer({ name: "zoho-analytics", version: "1.6.0" });

  async init(): Promise<void> {
    const client = clientFromEnv(this.env);
    registerTools(this.server, client, {
      orgId: this.env.ZOHO_ORG_ID,
      dc: this.env.ZOHO_DC ?? "com",
      readOnly: this.env.MCP_READONLY === "true",
      core: this.env.MCP_CORE === "true",
      ...integrationsFromEnv(this.env),
    });
    registerResourcesAndPrompts(this.server, client);
  }
}

/** Length-safe constant-time string comparison. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function authorized(request: Request, env: Env): boolean {
  // Fail closed: if no secret is configured, reject everything.
  if (!env.MCP_AUTH_TOKEN) return false;
  const header = request.headers.get("authorization") ?? "";
  // RFC 7235: the auth-scheme is case-insensitive.
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return false;
  return safeEqual(match[1], env.MCP_AUTH_TOKEN);
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

    // Signed export downloads (capability URL — the HMAC in the query IS the auth).
    if (request.method === "GET" && url.pathname.startsWith("/download/") && env.EXPORTS && env.MCP_AUTH_TOKEN) {
      const key = decodeURIComponent(url.pathname.slice("/download/".length));
      const exp = Number(url.searchParams.get("exp"));
      const sig = url.searchParams.get("sig") ?? "";
      if (!key.startsWith("exp/") || !(await verifyDownloadToken(key, exp, sig, env.MCP_AUTH_TOKEN))) {
        return new Response("Invalid or expired download link", { status: 403 });
      }
      const obj = await env.EXPORTS.get(key);
      if (!obj) return new Response("Export not found (expired)", { status: 404 });
      return new Response(obj.body, {
        status: 200,
        headers: { "content-type": obj.httpMetadata?.contentType ?? "application/octet-stream" },
      });
    }

    if (!authorized(request, env)) {
      return new Response("Unauthorized", {
        status: 401,
        headers: { "www-authenticate": "Bearer" },
      });
    }

    // Deployed-but-unconfigured guard: without Zoho credentials the client
    // constructor would throw inside the Durable Object (an opaque 1101).
    // Surface the actual problem to the (already-authenticated) caller instead.
    const hasZohoCreds =
      !!env.ZOHO_ACCESS_TOKEN || !!(env.ZOHO_REFRESH_TOKEN && env.ZOHO_CLIENT_ID && env.ZOHO_CLIENT_SECRET);
    if (!hasZohoCreds) {
      return new Response(
        "Zoho credentials not configured. Set the ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET and ZOHO_REFRESH_TOKEN secrets (wrangler secret put ...) — see the README's deploy section.",
        { status: 503 },
      );
    }

    if (url.pathname === "/mcp") {
      return ZohoAnalyticsMCP.serve("/mcp").fetch(request, env, ctx);
    }
    if (url.pathname === "/sse" || url.pathname === "/sse/message") {
      return ZohoAnalyticsMCP.serveSSE("/sse").fetch(request, env, ctx);
    }
    return new Response("Not found", { status: 404 });
  },
};
