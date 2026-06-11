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
import { ZohoAnalyticsClient } from "./zohoanalytics.js";
import { registerTools } from "./tools.js";

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
  });
}

export class ZohoAnalyticsMCP extends McpAgent<Env> {
  server = new McpServer({ name: "zoho-analytics", version: "1.1.1" });

  async init(): Promise<void> {
    registerTools(this.server, clientFromEnv(this.env), {
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
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function authorized(request: Request, env: Env): boolean {
  // Fail closed: if no secret is configured, reject everything.
  if (!env.MCP_AUTH_TOKEN) return false;
  const header = request.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  return safeEqual(header.slice(prefix.length), env.MCP_AUTH_TOKEN);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Public, unauthenticated health check.
    if (request.method === "GET" && url.pathname === "/") {
      return new Response("zoho-analytics-mcp worker: ok", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    }

    if (!authorized(request, env)) {
      return new Response("Unauthorized", {
        status: 401,
        headers: { "www-authenticate": "Bearer" },
      });
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
