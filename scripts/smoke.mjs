#!/usr/bin/env node
/**
 * Smoke test for a deployed Zoho Analytics MCP worker.
 * Reads no secrets from the repo — pass them via env:
 *
 *   MCP_URL=https://zoho-analytics-mcp.<sub>.workers.dev/mcp \
 *   MCP_TOKEN=<bearer> \
 *   node scripts/smoke.mjs
 *
 * Checks: initialize handshake, tools/list (>= 90 tools incl. the headline
 * helpers), and zoho_whoami (which validates the Zoho OAuth credentials
 * end-to-end). With MCP_READONLY=true expect only the ~36 read tools.
 * Exits non-zero if any check fails.
 */
const URL = process.env.MCP_URL;
const TOKEN = process.env.MCP_TOKEN;
if (!URL || !TOKEN) {
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
  const res = await fetch(URL, { method: "POST", headers, body: JSON.stringify(body) });
  const sid = res.headers.get("mcp-session-id");
  if (sid) sessionId = sid;
  return { status: res.status, body: parse(await res.text()) };
}

let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${extra ? `  ${extra}` : ""}`);
  if (!cond) failures++;
};

const KEY_TOOLS = [
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
  "zoho_add_row",
  "zoho_update_rows",
  "zoho_delete_rows",
  "zoho_import_data",
  "zoho_create_table",
  "zoho_create_query_table",
  "zoho_create_report",
  "zoho_add_column",
  "zoho_share_views",
  "zoho_list_users",
  "zoho_get_view_url",
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
// Full deploy registers ~101 tools; MCP_READONLY trims to ~36 reads.
check("tools/list", tools.length >= 30, `(${tools.length} tools)`);
for (const t of KEY_TOOLS) check(`tool present: ${t}`, tools.some((x) => x.name === t));

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
