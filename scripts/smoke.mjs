#!/usr/bin/env node
/**
 * Smoke test for a deployed Zoho Analytics MCP worker.
 * Reads no secrets from the repo — pass them via env:
 *
 *   MCP_URL=https://zoho-analytics-mcp.<sub>.workers.dev/mcp \
 *   MCP_TOKEN=<bearer> \
 *   node scripts/smoke.mjs
 *
 * Checks: initialize handshake, tools/list (>= 130 tools on a full deploy,
 * >= 40 on read-only deploys, which are auto-detected so write-tool checks
 * are skipped), and zoho_whoami (which validates the Zoho OAuth credentials
 * end-to-end). Exits non-zero if any check fails.
 */
const ENDPOINT = process.env.MCP_URL; // not named URL — that would shadow the global URL constructor
const TOKEN = process.env.MCP_TOKEN;
if (!ENDPOINT || !TOKEN) {
  console.error("Set MCP_URL and MCP_TOKEN env vars.");
  process.exit(2);
}

const BASE_HEADERS = {
  Authorization: `Bearer ${TOKEN}`,
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};
const parse = (t) => {
  const line = (t || "").split("\n").find((x) => x.startsWith("data:"));
  try {
    return JSON.parse(line ? line.slice(5).trim() : t);
  } catch {
    return null;
  }
};

let sessionId = null;
async function rpc(body) {
  const headers = { ...BASE_HEADERS };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const res = await fetch(ENDPOINT, { method: "POST", headers, body: JSON.stringify(body) });
  const sid = res.headers.get("mcp-session-id");
  if (sid) sessionId = sid;
  return { status: res.status, body: parse(await res.text()) };
}

let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${extra ? `  ${extra}` : ""}`);
  if (!cond) failures++;
};

// Read tools must be present on EVERY deployment (incl. MCP_READONLY=true).
const READ_TOOLS = [
  "zoho_whoami",
  "zoho_get_orgs",
  "zoho_list_workspaces",
  "zoho_list_views",
  "zoho_describe_workspace",
  "zoho_get_view_details",
  "zoho_export_data",
  "zoho_query_data",
  "zoho_create_export_job",
  "zoho_get_export_job",
  "zoho_list_users",
  "zoho_get_view_url",
];
// Write tools are absent on MCP_READONLY deployments (auto-detected below).
const WRITE_TOOLS = [
  "zoho_add_row",
  "zoho_update_rows",
  "zoho_delete_rows",
  "zoho_import_data",
  "zoho_create_table",
  "zoho_create_query_table",
  "zoho_create_report",
  "zoho_add_column",
  "zoho_share_views",
  "zoho_create_variable",
];

const init = await rpc({
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "0" } },
});
check("initialize", init.status === 200 && !!sessionId);
await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });

const list = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
const tools = list.body?.result?.tools ?? [];
const has = (t) => tools.some((x) => x.name === t);
// Detect deployment mode: MCP_READONLY (no write tools) or MCP_CORE (~26 curated tools).
const readonly = !WRITE_TOOLS.some(has);
const core = !readonly && tools.length < 60;
if (readonly) console.log("note: read-only deployment detected — skipping write-tool checks");
if (core) console.log("note: MCP_CORE deployment detected (~26 curated tools)");
// Full deploy registers ~144 tools; MCP_READONLY trims to ~51 reads; MCP_CORE to ~26.
check("tools/list", tools.length >= (readonly ? 40 : core ? 20 : 130), `(${tools.length} tools)`);
const CORE_SUBSET = ["zoho_whoami", "zoho_list_workspaces", "zoho_describe_workspace", "zoho_query_data", "zoho_add_row", "zoho_import_data"];
for (const t of core ? CORE_SUBSET : READ_TOOLS) check(`tool present: ${t}`, has(t));
if (!readonly && !core) for (const t of WRITE_TOOLS) check(`tool present: ${t}`, has(t));

const resources = await rpc({ jsonrpc: "2.0", id: 4, method: "resources/list" });
check("resources/list (zoho://workspaces)", (resources.body?.result?.resources ?? []).some((r) => r.uri === "zoho://workspaces"));
const prompts = await rpc({ jsonrpc: "2.0", id: 5, method: "prompts/list" });
check("prompts/list (>= 2 prompts)", (prompts.body?.result?.prompts ?? []).length >= 2);

const who = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "zoho_whoami", arguments: {} } });
let whoOk = false;
try {
  whoOk = JSON.parse(who.body?.result?.content?.[0]?.text ?? "{}").ok === true;
} catch {
  /* ignore */
}
check("zoho_whoami (credentials valid)", whoOk && !who.body?.result?.isError);

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
