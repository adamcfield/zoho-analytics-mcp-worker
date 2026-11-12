/**
 * GET /health body shared by both workers (standard §8.2): unauthenticated,
 * never leaks a secret value, only whether it is set. `warnings` is the
 * alerting field — a non-empty array means the deployment needs attention.
 */
import { DC_DOMAINS } from "./zohoanalytics.js";
import { VERSION } from "./version.js";

export interface HealthEnv {
  ZOHO_CLIENT_ID?: string;
  ZOHO_CLIENT_SECRET?: string;
  ZOHO_REFRESH_TOKEN?: string;
  ZOHO_ACCESS_TOKEN?: string;
  ZOHO_ORG_ID?: string;
  ZOHO_DC?: string;
  MCP_READONLY?: string;
  MCP_CORE?: string;
}

export function healthBody(
  env: HealthEnv,
  worker: "bearer" | "oauth",
  extraWarnings: string[] = [],
  opts: { perUserZoho?: boolean; ownClients?: boolean; passphrase?: boolean; managed?: boolean } = {},
): Record<string, unknown> {
  const warnings = [...extraWarnings];
  const appCreds = !!(env.ZOHO_CLIENT_ID && env.ZOHO_CLIENT_SECRET);
  const workerCreds = !!env.ZOHO_ACCESS_TOKEN || (appCreds && !!env.ZOHO_REFRESH_TOKEN);
  // With bring-your-own clients, the worker-wide Zoho credentials are an optional fallback.
  if (!opts.ownClients && (opts.perUserZoho ? !appCreds : !workerCreds)) {
    warnings.push(
      opts.perUserZoho
        ? "ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET not set (multi-user mode needs the Zoho app credentials)"
        : "Zoho credentials not set (ZOHO_CLIENT_ID + ZOHO_CLIENT_SECRET + ZOHO_REFRESH_TOKEN)",
    );
  }
  if (env.ZOHO_ACCESS_TOKEN) warnings.push("ZOHO_ACCESS_TOKEN is set: static token expires hourly (testing only)");
  if (!env.ZOHO_ORG_ID && !opts.ownClients) warnings.push("ZOHO_ORG_ID not set");
  const dc = (env.ZOHO_DC ?? "com").toLowerCase();
  if (!(dc in DC_DOMAINS)) warnings.push(`ZOHO_DC "${env.ZOHO_DC}" is not a known data center`);
  for (const [k, v] of [["MCP_READONLY", env.MCP_READONLY], ["MCP_CORE", env.MCP_CORE]] as const) {
    if (v !== undefined && v !== "" && v !== "true" && v !== "false") warnings.push(`${k}="${v}" is ignored (only "true" enables it)`);
  }
  // Informational only: managed authorization is optional, so it never flips `ok`.
  const notes = worker === "oauth" && opts.managed === false ? ["managed authorization off (set ZOHO_EMA_SECRET to enable /managed)"] : [];
  return {
    ok: warnings.length === 0,
    service: "zoho-analytics-mcp",
    worker,
    version: VERSION,
    readOnly: env.MCP_READONLY === "true",
    core: env.MCP_CORE === "true",
    dataCenter: dc,
    ...(worker === "oauth"
      ? {
          credentialModes: [
            ...(opts.passphrase && !opts.perUserZoho ? ["owner-passphrase"] : []),
            ...(opts.perUserZoho ? ["zoho-user-login"] : []),
            ...(opts.ownClients ? ["zoho-own-client"] : []),
            ...(opts.managed ? ["managed"] : []),
          ],
        }
      : {}),
    warnings: [...warnings, ...notes],
  };
}

export function healthResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
