#!/usr/bin/env node
/**
 * LIVE integration test — exercises WRITE paths against a real Zoho org.
 *
 * Creates a disposable table (LiveTest_<ts>), inserts/queries/updates rows,
 * dry-runs the destructive tools, then deletes the table (trash + permanent).
 * Also hits the two read endpoints whose paths diverge between Zoho's OAS and
 * live docs (email schedules, datasources) to validate the live-docs choice.
 *
 * Deliberately guarded: refuses to run unless LIVE_WRITE=1.
 *
 *   MCP_URL=https://.../mcp MCP_TOKEN=<bearer> LIVE_WRITE=1 node scripts/live-test.mjs
 */
const ENDPOINT = process.env.MCP_URL;
const TOKEN = process.env.MCP_TOKEN;
if (!ENDPOINT || !TOKEN) { console.error("Set MCP_URL and MCP_TOKEN."); process.exit(2); }
if (process.env.LIVE_WRITE !== "1") { console.error("Refusing: set LIVE_WRITE=1 to run live write tests."); process.exit(2); }

const base = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
let sid = null;
const parse = (t) => { const l = (t || "").split("\n").find((x) => x.startsWith("data:")); try { return JSON.parse(l ? l.slice(5).trim() : t); } catch { return null; } };
async function rpc(b) { const h = { ...base }; if (sid) h["mcp-session-id"] = sid; const r = await fetch(ENDPOINT, { method: "POST", headers: h, body: JSON.stringify(b) }); const s = r.headers.get("mcp-session-id"); if (s) sid = s; return parse(await r.text()); }
async function call(name, args) { const r = await rpc({ jsonrpc: "2.0", id: Math.floor(Math.random() * 1e9), method: "tools/call", params: { name, arguments: args } }); const res = r?.result; const text = res?.content?.[0]?.text ?? ""; let json; try { json = JSON.parse(text); } catch { } return { err: res?.isError === true, text, json }; }

let failures = 0;
const check = (name, cond, extra = "") => { console.log(`${cond ? "ok  " : "FAIL"} ${name}${extra ? `  ${extra}` : ""}`); if (!cond) failures++; };

await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "live-test", version: "1" } } });
await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });

// Resolve a workspace to test in (first owned).
const ws = await call("zoho_list_workspaces", {});
const wsId = ws.json?.ownedWorkspaces?.[0]?.workspaceId;
check("workspace resolved", !!wsId, `(${ws.json?.ownedWorkspaces?.[0]?.workspaceName ?? "?"})`);
if (!wsId) process.exit(1);

// Divergent-path reads (live-docs paths beat the OAS here — validate them live).
const sched = await call("zoho_list_email_schedules", { workspace_id: wsId });
check("email schedules list (live-docs path)", !sched.err, sched.err ? sched.text.slice(0, 120) : "");
const ds = await call("zoho_list_datasources", { workspace_id: wsId });
check("datasources list (live-docs path)", !ds.err, ds.err ? ds.text.slice(0, 120) : "");

// Disposable-table write cycle.
const table = `LiveTest_${Date.now()}`;
const created = await call("zoho_create_table", {
  workspace_id: wsId,
  table_name: table,
  columns: [
    { name: "Name", type: "PLAIN" },
    { name: "Amount", type: "NUMBER" },
  ],
});
const viewId = created.json?.data?.viewId ?? created.json?.viewId;
check("create_table", !created.err && !!viewId, created.err ? created.text.slice(0, 160) : `(${table})`);

if (viewId) {
  const add = await call("zoho_add_row", { workspace_id: wsId, view_id: String(viewId), columns: { Name: "alpha", Amount: 42 } });
  check("add_row", !add.err, add.err ? add.text.slice(0, 160) : "");
  const add2 = await call("zoho_add_row", { workspace_id: wsId, view_id: String(viewId), columns: { Name: "beta", Amount: 58 } });
  check("add_row (2nd)", !add2.err);

  const q = await call("zoho_query_data", {
    workspace_id: wsId,
    sql_query: `SELECT COUNT(*) AS "N", SUM("Amount") AS "Total" FROM "${table}"`,
    timeout_seconds: 110,
  });
  const row = q.json?.rows?.[0];
  check("query_data on new table", !q.err && q.json?.done === true, q.err ? q.text.slice(0, 160) : `(N=${row?.N}, Total=${row?.Total})`);
  if (q.json?.done) check("query result correct", String(row?.N) === "2" && String(row?.Total) === "100");

  const upd = await call("zoho_update_rows", { workspace_id: wsId, view_id: String(viewId), columns: { Amount: 43 }, criteria: `"${table}"."Name"='alpha'`, dry_run: true });
  check("update_rows dry_run", !upd.err && upd.json?.dry_run === true);
  const del = await call("zoho_delete_rows", { workspace_id: wsId, view_id: String(viewId), criteria: `"${table}"."Name"='beta'`, dry_run: true });
  check("delete_rows dry_run", !del.err && del.json?.dry_run === true);
  const imp = await call("zoho_import_data", { workspace_id: wsId, view_id: String(viewId), data: "Name,Amount\ngamma,1", dry_run: true });
  check("import_data dry_run", !imp.err && imp.json?.dry_run === true);

  // Cleanup: trash, verify in trash, permanently delete.
  const trash = await call("zoho_delete_view", { workspace_id: wsId, view_id: String(viewId) });
  check("delete_view (to trash)", !trash.err, trash.err ? trash.text.slice(0, 160) : "");
  const trashed = await call("zoho_get_trash", { workspace_id: wsId });
  const inTrash = JSON.stringify(trashed.json ?? {}).includes(String(viewId));
  check("table appears in trash", inTrash);
  const purge = await call("zoho_delete_trash_view", { workspace_id: wsId, view_id: String(viewId) });
  check("delete_trash_view (permanent)", !purge.err, purge.err ? purge.text.slice(0, 160) : "");
}

console.log(failures ? `\n${failures} live check(s) failed.` : "\nAll live checks passed.");
process.exit(failures ? 1 : 0);
