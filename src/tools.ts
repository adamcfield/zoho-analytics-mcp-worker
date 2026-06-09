/**
 * Shared Zoho Analytics tool registration.
 *
 * Used by BOTH the bearer Worker (src/index.ts) and the OAuth-gated Worker
 * (src/oauth.ts), so the tool surface, schemas, and safety annotations stay
 * identical across transports.
 *
 * Tool naming: zoho_<verb>_<noun>. Reads use server.registerTool directly;
 * writes go through `writeTool`, which is a no-op when MCP_READONLY is set so
 * mutating tools never even appear in tools/list on reporting-only deploys.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ZohoAnalyticsClient,
  ZohoAnalyticsError,
  VIEW_TYPE_NAMES,
  JOB_CODE,
  mapLimit,
  sleep,
  type ResponseFormat,
} from "./zohoanalytics.js";

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};
type AnyRec = Record<string, any>;

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Run an API call and normalize errors into a tool error (never throw). */
async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    if (err instanceof ZohoAnalyticsError) {
      return fail(
        `Zoho Analytics API error ${err.status}` +
          (err.errorCode != null ? ` (errorCode ${err.errorCode})` : "") +
          `\n${err.body}`,
      );
    }
    return fail(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Lightweight, non-PII audit line for write operations (surfaced via `wrangler tail`). */
function audit(action: string, meta: Record<string, unknown>): void {
  try {
    console.log(`[zoho-analytics-mcp audit] ${action} ${JSON.stringify(meta)}`);
  } catch {
    /* never let logging break a tool call */
  }
}

// ---- Helpers shared by the tools (exported for unit tests) ----

export const readableViewType = (code?: string | number): string =>
  VIEW_TYPE_NAMES[String(code ?? "")] ?? `type ${code ?? "unknown"}`;

/** Trim a view object to the fields that matter (keeps LLM context small). */
export function compactView(v: AnyRec): AnyRec {
  return {
    viewId: v.viewId ?? null,
    viewName: v.viewName ?? null,
    viewType: readableViewType(v.viewType),
    viewTypeCode: v.viewType ?? null,
  };
}

/**
 * Parse a Zoho data-export body (JSON) into an array of row objects, tolerating
 * the several shapes Zoho returns: a bare array, { data: [...] } (keyValueFormat),
 * or the { response: { result: { rows, column_order } } } column/row form.
 */
export function parseExportRows(text: string): { rows: AnyRec[]; raw?: string } {
  let p: any;
  try {
    p = JSON.parse(text);
  } catch {
    return { rows: [], raw: text };
  }
  if (Array.isArray(p)) return { rows: p };
  if (Array.isArray(p?.data)) return { rows: p.data };
  if (Array.isArray(p?.data?.rows)) return { rows: p.data.rows };
  const result = p?.response?.result;
  if (result && Array.isArray(result.rows)) {
    const cols: string[] = result.column_order ?? [];
    return {
      rows: result.rows.map((r: unknown[]) =>
        Object.fromEntries((r ?? []).map((val, i) => [cols[i] ?? `col_${i}`, val])),
      ),
    };
  }
  return { rows: [], raw: JSON.stringify(p) };
}

/** Best-effort column extraction from a get-view-details envelope (shape varies). */
export function extractColumns(viewDetailEnvelope: AnyRec): AnyRec[] {
  const views = viewDetailEnvelope?.data?.views ?? viewDetailEnvelope?.views ?? viewDetailEnvelope ?? {};
  const cols = views.columns ?? views.involvedColumns ?? viewDetailEnvelope?.data?.columns ?? [];
  if (!Array.isArray(cols)) return [];
  return cols
    .map((c: AnyRec) => ({
      columnName: c.columnName ?? c.COLUMNNAME ?? c.name ?? null,
      dataType: c.dataType ?? c.DATATYPE ?? c.dataTypeName ?? c.type ?? null,
    }))
    .filter((c) => c.columnName);
}

/** Cap a row array for return, reporting whether it was truncated. */
export function capRows(rows: AnyRec[], max: number): { rows: AnyRec[]; truncated: boolean; total: number } {
  const truncated = rows.length > max;
  return { rows: truncated ? rows.slice(0, max) : rows, truncated, total: rows.length };
}

// Annotations: hints so a client knows which tools are safe to auto-run.
// All tools call an external service, so openWorldHint is true throughout.
const READ_ONLY = { readOnlyHint: true, idempotentHint: true, openWorldHint: true } as const;

const TABLE_DATATYPES = [
  "PLAIN",
  "MULTI_LINE",
  "EMAIL",
  "NUMBER",
  "POSITIVE_NUMBER",
  "DECIMAL_NUMBER",
  "CURRENCY",
  "PERCENT",
  "DATE",
  "BOOLEAN",
  "URL",
  "AUTO_NUMBER",
  "GEO",
] as const;

const cellValue = z.union([z.string(), z.number(), z.boolean()]);

export interface RegisterToolsOptions {
  /** The configured org id (shown by zoho_whoami). */
  orgId?: string;
  /** The configured data-center key (shown by zoho_whoami). */
  dc?: string;
  /** When true, write/state-changing tools are not registered at all (reporting-only deploys). */
  readOnly?: boolean;
}

/** Register all Zoho Analytics tools onto the given MCP server. */
export function registerTools(
  server: McpServer,
  client: ZohoAnalyticsClient,
  opts: RegisterToolsOptions = {},
): void {
  // Register a write/state-changing tool — a no-op when the server is read-only
  // (MCP_READONLY), so those tools never even appear in tools/list. Typed as the
  // real method so handler arg inference from the Zod inputSchema is preserved.
  const noop = (() => undefined) as unknown as McpServer["registerTool"];
  const writeTool: McpServer["registerTool"] = opts.readOnly
    ? noop
    : (server.registerTool.bind(server) as McpServer["registerTool"]);

  // ============================ Reads ============================

  server.registerTool(
    "zoho_whoami",
    {
      description:
        "Health check / identity: verifies the OAuth credentials work by listing the organizations the token can access, and echoes the configured org id and data center. Call this first if other tools return 401/403/7103 — it confirms auth before you debug anything else.",
      inputSchema: {},
      annotations: { title: "Who am I (auth health)", ...READ_ONLY },
    },
    async () =>
      run(async () => {
        const orgs = (await client.getOrgs()) as AnyRec;
        return {
          ok: true,
          configured_org_id: opts.orgId ?? null,
          data_center: opts.dc ?? "com",
          orgs: orgs?.data?.orgs ?? orgs?.data ?? orgs,
        };
      }),
  );

  server.registerTool(
    "zoho_get_orgs",
    {
      description:
        "List the Zoho Analytics organizations this account can access, with each org's id and name. Use the orgId here as the ZANALYTICS-ORGID the server is configured with.",
      inputSchema: {},
      annotations: { title: "Get organizations", ...READ_ONLY },
    },
    async () => run(() => client.getOrgs()),
  );

  server.registerTool(
    "zoho_list_workspaces",
    {
      description:
        "List all workspaces (databases) — both owned and shared. Returns compact { workspaceId, workspaceName } entries by default; set verbose=true for the full objects. Workspaces contain the views (tables, query tables, dashboards) you query.",
      inputSchema: {
        verbose: z.boolean().optional().describe("Return full workspace objects instead of compact id/name."),
      },
      annotations: { title: "List workspaces", ...READ_ONLY },
    },
    async ({ verbose }) =>
      run(async () => {
        const res = (await client.getWorkspaces()) as AnyRec;
        const data = res?.data ?? res;
        if (verbose) return data;
        const trim = (ws: AnyRec[] | undefined) =>
          (ws ?? []).map((w) => ({ workspaceId: w.workspaceId, workspaceName: w.workspaceName, isDefault: w.isDefault ?? null }));
        return {
          ownedWorkspaces: trim(data?.ownedWorkspaces),
          sharedWorkspaces: trim(data?.sharedWorkspaces),
        };
      }),
  );

  server.registerTool(
    "zoho_get_workspace_details",
    {
      description: "Get details of a single workspace by id (name, description, owner, created time, org).",
      inputSchema: { workspace_id: z.string().describe("Workspace (database) id.") },
      annotations: { title: "Get workspace details", ...READ_ONLY },
    },
    async ({ workspace_id }) => run(() => client.getWorkspaceDetails(workspace_id)),
  );

  server.registerTool(
    "zoho_list_views",
    {
      description:
        "List the views in a workspace. A 'view' is a table, query table, chart, pivot, summary, or dashboard. Filter by view_types (e.g. ['Table','Query Table']) and/or a keyword. Returns compact { viewId, viewName, viewType } unless verbose=true.",
      inputSchema: {
        workspace_id: z.string().describe("Workspace id."),
        view_types: z
          .array(z.enum(["Table", "Tabular View", "Chart", "Pivot", "Summary", "Query Table", "Dashboard"]))
          .optional()
          .describe("Restrict to these view types."),
        keyword: z.string().optional().describe("Filter views whose name contains this keyword."),
        verbose: z.boolean().optional().describe("Return full view objects instead of compact id/name/type."),
      },
      annotations: { title: "List views", ...READ_ONLY },
    },
    async ({ workspace_id, view_types, keyword, verbose }) =>
      run(async () => {
        const nameToCode: Record<string, number> = {};
        for (const [code, name] of Object.entries(VIEW_TYPE_NAMES)) nameToCode[name] = Number(code);
        const config: Record<string, unknown> = {};
        if (view_types?.length) config.viewTypes = view_types.map((t) => nameToCode[t]).filter((n) => n !== undefined);
        if (keyword) config.keyword = keyword;
        const res = (await client.getViews(workspace_id, Object.keys(config).length ? config : undefined)) as AnyRec;
        const views: AnyRec[] = res?.data?.views ?? res?.data ?? [];
        if (verbose) return res?.data ?? res;
        return { count: views.length, views: views.map(compactView) };
      }),
  );

  server.registerTool(
    "zoho_get_view_details",
    {
      description:
        "Get details of a single view by id. By default includes column metadata (with_columns=true → withInvolvedMetaInfo), so you can see a table's columns and data types before querying it.",
      inputSchema: {
        view_id: z.string().describe("View id."),
        with_columns: z.boolean().optional().describe("Include column / involved-meta info (default true)."),
      },
      annotations: { title: "Get view details", ...READ_ONLY },
    },
    async ({ view_id, with_columns }) =>
      run(() => client.getViewDetails(view_id, with_columns === false ? undefined : { withInvolvedMetaInfo: true })),
  );

  server.registerTool(
    "zoho_get_metadata",
    {
      description:
        "Look up workspace (and optionally view) metadata BY NAME rather than by id — returns workspace info and, when view_name is given, the view plus its column metadata. Handy when you only know names.",
      inputSchema: {
        workspace_name: z.string().describe("Workspace name."),
        view_name: z.string().optional().describe("View/table name (omit for workspace-level metadata)."),
      },
      annotations: { title: "Get metadata by name", ...READ_ONLY },
    },
    async ({ workspace_name, view_name }) => run(() => client.getMetaDetails(workspace_name, view_name)),
  );

  server.registerTool(
    "zoho_describe_workspace",
    {
      description:
        "High-level schema map of a workspace: lists its views and (for tables/query tables) fetches each one's columns with bounded concurrency, returning a compact { viewName, viewType, columns:[{columnName,dataType}] } per view. The fastest way to understand a workspace's structure before writing a SQL query with zoho_query_data. Caps at max_views (default 50).",
      inputSchema: {
        workspace_id: z.string().describe("Workspace id."),
        include_columns: z.boolean().optional().describe("Fetch column metadata per table view (default true)."),
        max_views: z.number().int().min(1).max(200).optional().describe("Max views to describe (default 50)."),
        concurrency: z.number().int().min(1).max(6).optional().describe("Parallel column lookups (default 4)."),
      },
      annotations: { title: "Describe workspace (schema map)", ...READ_ONLY },
    },
    async ({ workspace_id, include_columns, max_views, concurrency }) =>
      run(async () => {
        const res = (await client.getViews(workspace_id)) as AnyRec;
        const all: AnyRec[] = res?.data?.views ?? res?.data ?? [];
        const views = all.slice(0, max_views ?? 50);
        const wantCols = include_columns !== false;
        const described = await mapLimit(views, concurrency ?? 4, async (v) => {
          const base = compactView(v);
          const isTabular = ["0", "1", "6"].includes(String(v.viewType)); // Table, Tabular View, Query Table
          if (!wantCols || !isTabular || !v.viewId) return base;
          try {
            const detail = (await client.getViewDetails(String(v.viewId), { withInvolvedMetaInfo: true })) as AnyRec;
            return { ...base, columns: extractColumns(detail) };
          } catch (e) {
            return { ...base, columns: [], columns_error: e instanceof ZohoAnalyticsError ? `API ${e.status}` : String(e) };
          }
        });
        return {
          workspace_id,
          view_count: all.length,
          described: described.length,
          truncated: all.length > described.length,
          views: described,
        };
      }),
  );

  server.registerTool(
    "zoho_export_data",
    {
      description:
        "Export the rows of a table/view SYNCHRONOUSLY and return them as parsed rows (response_format=json, default) — the quick way to read a whole table or a filtered slice. Use `criteria` to filter and `selected_columns` to project. NOT allowed for views over 1,000,000 rows, live-connect workspaces, or Dashboard/Query-Table views — use zoho_query_data or zoho_create_export_job for those. Caps returned rows at max_rows.",
      inputSchema: {
        workspace_id: z.string().describe("Workspace id."),
        view_id: z.string().describe("View/table id."),
        criteria: z
          .string()
          .optional()
          .describe(`Filter, fully-qualified & quoted: "\\"TableName\\".\\"Column\\"='value'" (e.g. "\\"Sales\\".\\"Region\\"='East'").`),
        selected_columns: z.array(z.string()).optional().describe("Only return these columns."),
        response_format: z.enum(["json", "csv"]).optional().describe("Output format (default json → parsed rows; csv → raw text)."),
        max_rows: z.number().int().min(1).max(100000).optional().describe("Max rows to return when json (default 1000)."),
      },
      annotations: { title: "Export view data (sync)", ...READ_ONLY },
    },
    async ({ workspace_id, view_id, criteria, selected_columns, response_format, max_rows }) =>
      run(async () => {
        const fmt = (response_format ?? "json") as ResponseFormat;
        const config: Record<string, unknown> = { responseFormat: fmt };
        if (fmt === "json") config.keyValueFormat = true;
        if (criteria) config.criteria = criteria;
        if (selected_columns?.length) config.selectedColumns = selected_columns;
        const raw = await client.exportData(workspace_id, view_id, config);
        if (fmt !== "json") {
          const capped = raw.length > 100_000;
          return { format: fmt, data: capped ? raw.slice(0, 100_000) : raw, truncated_chars: capped };
        }
        const { rows, raw: rawJson } = parseExportRows(raw);
        if (rows.length === 0 && rawJson !== undefined) return { row_count: 0, raw: rawJson.slice(0, 50_000) };
        const { rows: out, truncated, total } = capRows(rows, max_rows ?? 1000);
        return { row_count: total, returned: out.length, truncated, rows: out };
      }),
  );

  server.registerTool(
    "zoho_query_data",
    {
      description:
        "Run an ad-hoc SQL SELECT against a workspace and return the result rows. This is the headline analytics tool. Under the hood it creates an async bulk export job from your SQL, polls it to completion, downloads the result, and parses it. Use standard SQL with double-quoted table/column names, e.g. SELECT \"Region\", SUM(\"Sales\") FROM \"Orders\" GROUP BY \"Region\". For very large results that may exceed the wait window, use zoho_create_export_job + zoho_get_export_job instead. Caps returned rows at max_rows.",
      inputSchema: {
        workspace_id: z.string().describe("Workspace id to run the query against."),
        sql_query: z.string().describe('SQL SELECT. Quote identifiers: SELECT "col" FROM "Table" WHERE ...'),
        max_rows: z.number().int().min(1).max(100000).optional().describe("Max rows to return (default 1000). Also consider LIMIT in SQL."),
        timeout_seconds: z.number().int().min(1).max(60).optional().describe("Max seconds to wait for the export job (default 30, hard cap 60)."),
      },
      annotations: { title: "Query data (SQL)", ...READ_ONLY },
    },
    async ({ workspace_id, sql_query, max_rows, timeout_seconds }) =>
      run(async () => {
        const created = (await client.createExportJobBySql(workspace_id, sql_query, "json")) as AnyRec;
        const jobId = created?.data?.jobId ?? created?.jobId;
        if (!jobId) throw new Error(`Export job was not created: ${JSON.stringify(created)}`);
        const deadline = Date.now() + Math.min(timeout_seconds ?? 30, 60) * 1000;
        const interval = 2000;
        for (;;) {
          const st = (await client.getExportJobStatus(workspace_id, String(jobId))) as AnyRec;
          const code = String(st?.data?.jobCode ?? "");
          if (code === JOB_CODE.COMPLETED) break;
          if (code === JOB_CODE.INVALID) throw new Error(`Export job ${jobId} is invalid (jobCode 1005).`);
          if (Date.now() + interval >= deadline) {
            return {
              job_id: jobId,
              done: false,
              job_code: code,
              note: "Query still running. Poll zoho_get_export_job with download=true to fetch results when ready.",
            };
          }
          await sleep(interval);
        }
        const raw = await client.downloadExportData(workspace_id, String(jobId));
        const { rows, raw: rawJson } = parseExportRows(raw);
        if (rows.length === 0 && rawJson !== undefined) return { job_id: jobId, done: true, row_count: 0, raw: rawJson.slice(0, 50_000) };
        const { rows: out, truncated, total } = capRows(rows, max_rows ?? 1000);
        return { job_id: jobId, done: true, row_count: total, returned: out.length, truncated, rows: out };
      }),
  );

  server.registerTool(
    "zoho_create_export_job",
    {
      description:
        "Start an ASYNCHRONOUS export job (for large exports you don't want to block on) and return its job_id. Provide EITHER sql_query (export the query result) OR view_id (export a whole view). Then poll zoho_get_export_job(job_id, download=true) to fetch the data once it's ready. Defaults to CSV (best for large/raw exports).",
      inputSchema: {
        workspace_id: z.string().describe("Workspace id."),
        sql_query: z.string().optional().describe("SQL SELECT to export (alternative to view_id)."),
        view_id: z.string().optional().describe("View id to export in full (alternative to sql_query)."),
        response_format: z.enum(["csv", "json"]).optional().describe("Output format (default csv)."),
        criteria: z.string().optional().describe("Optional filter when exporting a view_id."),
      },
      annotations: { title: "Create export job (async)", readOnlyHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ workspace_id, sql_query, view_id, response_format, criteria }) =>
      run(async () => {
        const fmt = (response_format ?? "csv") as ResponseFormat;
        if (!sql_query && !view_id) throw new Error("Provide either sql_query or view_id.");
        if (sql_query && view_id) throw new Error("Provide only one of sql_query or view_id, not both.");
        const res = sql_query
          ? ((await client.createExportJobBySql(workspace_id, sql_query, fmt)) as AnyRec)
          : ((await client.createExportJobByView(workspace_id, view_id!, {
              responseFormat: fmt,
              ...(criteria ? { criteria } : {}),
            })) as AnyRec);
        return { job_id: res?.data?.jobId ?? res?.jobId ?? null, raw: res?.data ?? res };
      }),
  );

  server.registerTool(
    "zoho_get_export_job",
    {
      description:
        "Check an asynchronous export job's status (jobCode 1001/1002 = running, 1004 = done, 1005 = invalid). Set download=true to also fetch the data once the job is complete — returns parsed rows for json exports or raw text for csv.",
      inputSchema: {
        workspace_id: z.string().describe("Workspace id."),
        job_id: z.string().describe("Export job id from zoho_create_export_job / zoho_query_data."),
        download: z.boolean().optional().describe("If the job is complete, also download and return its data."),
        max_rows: z.number().int().min(1).max(100000).optional().describe("Max rows to return when downloading json (default 1000)."),
      },
      annotations: { title: "Get export job", ...READ_ONLY },
    },
    async ({ workspace_id, job_id, download, max_rows }) =>
      run(async () => {
        const st = (await client.getExportJobStatus(workspace_id, job_id)) as AnyRec;
        const code = String(st?.data?.jobCode ?? "");
        const status = { job_id, job_code: code, done: code === JOB_CODE.COMPLETED, detail: st?.data ?? st };
        if (!download || code !== JOB_CODE.COMPLETED) return status;
        const raw = await client.downloadExportData(workspace_id, job_id);
        const { rows, raw: rawJson } = parseExportRows(raw);
        if (rows.length === 0) {
          // CSV (or unrecognized) — return raw text, capped.
          const text = rawJson ?? raw;
          return { ...status, data: text.slice(0, 100_000), truncated_chars: text.length > 100_000 };
        }
        const { rows: out, truncated, total } = capRows(rows, max_rows ?? 1000);
        return { ...status, row_count: total, returned: out.length, truncated, rows: out };
      }),
  );

  server.registerTool(
    "zoho_get_import_job",
    {
      description:
        "Check an asynchronous import job's status and summary (jobCode 1004 = done; jobInfo.importSummary has totalRowCount / successRowCount / warnings). Use after zoho_import_data when you didn't wait inline.",
      inputSchema: {
        workspace_id: z.string().describe("Workspace id."),
        job_id: z.string().describe("Import job id from zoho_import_data."),
      },
      annotations: { title: "Get import job", ...READ_ONLY },
    },
    async ({ workspace_id, job_id }) => run(() => client.getImportJobStatus(workspace_id, job_id)),
  );

  // ============================ Writes ============================

  writeTool(
    "zoho_add_row",
    {
      description:
        "Add a single row to a table. Provide columns as a { columnName: value } map. Returns the added/invalid columns. Use date_format if any column value is a date string.",
      inputSchema: {
        workspace_id: z.string().describe("Workspace id."),
        view_id: z.string().describe("Table id to insert into."),
        columns: z.record(z.string(), cellValue).describe('Column values, e.g. { "Region": "East", "Sales": 100 }.'),
        date_format: z.string().optional().describe("Date format for any date column values, e.g. 'yyyy-MM-dd'."),
        dry_run: z.boolean().optional().describe("Preview the row without inserting anything."),
      },
      annotations: { title: "Add row", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ workspace_id, view_id, columns, date_format, dry_run }) => {
      if (dry_run) return ok({ dry_run: true, action: "add_row", view_id, columns, note: "Nothing was inserted." });
      audit("add_row", { workspace_id, view_id, columns: Object.keys(columns) });
      const config: Record<string, unknown> = { columns };
      if (date_format) config.dateFormat = date_format;
      return run(() => client.addRow(workspace_id, view_id, config));
    },
  );

  writeTool(
    "zoho_update_rows",
    {
      description:
        "Update rows in a table. Sets the given columns on rows matching `criteria`. To update EVERY row you must explicitly pass update_all_rows=true (and omit criteria). Set add_if_not_exist=true to insert a row when no match is found. Always preview with dry_run first.",
      inputSchema: {
        workspace_id: z.string().describe("Workspace id."),
        view_id: z.string().describe("Table id."),
        columns: z.record(z.string(), cellValue).describe("Column values to set on matching rows."),
        criteria: z
          .string()
          .optional()
          .describe(`Which rows to update, fully-qualified & quoted: "\\"Table\\".\\"Column\\"='value'". Required unless update_all_rows.`),
        update_all_rows: z.boolean().optional().describe("Update ALL rows (only when criteria is omitted). Use with care."),
        add_if_not_exist: z.boolean().optional().describe("Insert a new row if no row matches criteria."),
        date_format: z.string().optional().describe("Date format for any date column values."),
        dry_run: z.boolean().optional().describe("Preview without updating anything."),
      },
      annotations: { title: "Update rows", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ workspace_id, view_id, columns, criteria, update_all_rows, add_if_not_exist, date_format, dry_run }) => {
      if (!criteria && !update_all_rows) {
        return fail("Provide `criteria` to target rows, or pass update_all_rows=true to update every row.");
      }
      if (dry_run) {
        return ok({
          dry_run: true,
          action: "update_rows",
          view_id,
          columns,
          criteria: criteria ?? null,
          update_all_rows: !!update_all_rows,
          note: "Nothing was updated.",
        });
      }
      audit("update_rows", { workspace_id, view_id, columns: Object.keys(columns), update_all_rows: !!update_all_rows });
      const config: Record<string, unknown> = { columns };
      if (criteria) config.criteria = criteria;
      if (update_all_rows) config.updateAllRows = true;
      if (add_if_not_exist) config.addIfNotExist = true;
      if (date_format) config.dateFormat = date_format;
      return run(() => client.updateRows(workspace_id, view_id, config));
    },
  );

  writeTool(
    "zoho_delete_rows",
    {
      description:
        "Delete rows from a table that match `criteria`. To delete EVERY row you must explicitly pass delete_all_rows=true (and omit criteria). Irreversible — always preview with dry_run first.",
      inputSchema: {
        workspace_id: z.string().describe("Workspace id."),
        view_id: z.string().describe("Table id."),
        criteria: z
          .string()
          .optional()
          .describe(`Which rows to delete, fully-qualified & quoted: "\\"Table\\".\\"Column\\"='value'". Required unless delete_all_rows.`),
        delete_all_rows: z.boolean().optional().describe("Delete ALL rows (only when criteria is omitted). Dangerous."),
        dry_run: z.boolean().optional().describe("Preview without deleting anything."),
      },
      annotations: { title: "Delete rows", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ workspace_id, view_id, criteria, delete_all_rows, dry_run }) => {
      if (!criteria && !delete_all_rows) {
        return fail("Provide `criteria` to target rows, or pass delete_all_rows=true to delete every row.");
      }
      if (dry_run) {
        return ok({
          dry_run: true,
          action: "delete_rows",
          view_id,
          criteria: criteria ?? null,
          delete_all_rows: !!delete_all_rows,
          note: "Nothing was deleted.",
        });
      }
      audit("delete_rows", { workspace_id, view_id, delete_all_rows: !!delete_all_rows });
      const config: Record<string, unknown> = criteria ? { criteria } : { deleteAllRows: true };
      return run(() => client.deleteRows(workspace_id, view_id, config));
    },
  );

  writeTool(
    "zoho_import_data",
    {
      description:
        "Bulk-import data (CSV or JSON text) into an existing table via an async job. import_type: 'append' (add rows), 'truncateadd' (REPLACE all data), or 'updateadd' (upsert — requires matching_columns). By default waits for the job to finish and returns the import summary; set wait=false to return the job_id immediately and poll zoho_get_import_job. Preview with dry_run.",
      inputSchema: {
        workspace_id: z.string().describe("Workspace id."),
        view_id: z.string().describe("Target table id."),
        data: z.string().describe("The file content to import (CSV or JSON text)."),
        file_type: z.enum(["csv", "json"]).optional().describe("Format of `data` (default csv)."),
        import_type: z.enum(["append", "truncateadd", "updateadd"]).optional().describe("How to import (default append). truncateadd REPLACES all rows."),
        matching_columns: z.array(z.string()).optional().describe("Key columns for updateadd (upsert). Required when import_type=updateadd."),
        auto_identify: z.boolean().optional().describe("Auto-identify column data types (default true)."),
        on_error: z.enum(["abort", "skiprow", "setcolumnempty"]).optional().describe("Behavior on a bad row (default abort)."),
        wait: z.boolean().optional().describe("Wait for the job to complete and return its summary (default true)."),
        timeout_seconds: z.number().int().min(1).max(60).optional().describe("Max seconds to wait when wait=true (default 30, cap 60)."),
        dry_run: z.boolean().optional().describe("Preview the import config without uploading anything."),
      },
      annotations: { title: "Import data (bulk)", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (a) => {
      const fileType = a.file_type ?? "csv";
      const importType = a.import_type ?? "append";
      if (importType === "updateadd" && !a.matching_columns?.length) {
        return fail("matching_columns is required when import_type=updateadd (the key columns to match on).");
      }
      if (a.dry_run) {
        return ok({
          dry_run: true,
          action: "import_data",
          view_id: a.view_id,
          file_type: fileType,
          import_type: importType,
          bytes: a.data.length,
          note: importType === "truncateadd" ? "Would REPLACE all existing rows. Nothing was imported." : "Nothing was imported.",
        });
      }
      audit("import_data", { workspace_id: a.workspace_id, view_id: a.view_id, import_type: importType, bytes: a.data.length });
      const config: Record<string, unknown> = {
        importType,
        fileType,
        autoIdentify: String(a.auto_identify ?? true),
        onError: a.on_error ?? "abort",
      };
      if (a.matching_columns?.length) config.matchingColumns = a.matching_columns;
      return run(async () => {
        const created = (await client.createImportJob(
          a.workspace_id,
          a.view_id,
          { content: a.data, name: `import.${fileType}`, type: fileType === "json" ? "application/json" : "text/csv" },
          config,
        )) as AnyRec;
        const jobId = created?.data?.jobId ?? created?.jobId;
        if (a.wait === false || !jobId) {
          return { job_id: jobId ?? null, done: false, note: "Poll zoho_get_import_job for the result.", raw: created?.data ?? created };
        }
        const deadline = Date.now() + Math.min(a.timeout_seconds ?? 30, 60) * 1000;
        const interval = 2000;
        for (;;) {
          const st = (await client.getImportJobStatus(a.workspace_id, String(jobId))) as AnyRec;
          const code = String(st?.data?.jobCode ?? "");
          if (code === JOB_CODE.COMPLETED) {
            return { job_id: jobId, done: true, summary: st?.data?.jobInfo?.importSummary ?? st?.data };
          }
          if (code === JOB_CODE.INVALID) throw new Error(`Import job ${jobId} is invalid (jobCode 1005).`);
          if (Date.now() + interval >= deadline) {
            return { job_id: jobId, done: false, job_code: code, note: "Import still running. Poll zoho_get_import_job." };
          }
          await sleep(interval);
        }
      });
    },
  );

  writeTool(
    "zoho_create_workspace",
    {
      description: "Create a new workspace (database). Returns the new workspaceId.",
      inputSchema: {
        workspace_name: z.string().describe("Name for the new workspace."),
        workspace_desc: z.string().optional().describe("Optional description."),
      },
      annotations: { title: "Create workspace", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ workspace_name, workspace_desc }) => {
      audit("create_workspace", { workspace_name });
      return run(() => client.createWorkspace(workspace_name, workspace_desc));
    },
  );

  writeTool(
    "zoho_create_table",
    {
      description:
        "Create a new table in a workspace with a column design. Each column needs a name and a DATATYPE (PLAIN, MULTI_LINE, EMAIL, NUMBER, POSITIVE_NUMBER, DECIMAL_NUMBER, CURRENCY, PERCENT, DATE, BOOLEAN, URL, AUTO_NUMBER, GEO). Returns the new viewId.",
      inputSchema: {
        workspace_id: z.string().describe("Workspace id."),
        table_name: z.string().describe("Name for the new table."),
        columns: z
          .array(
            z.object({
              name: z.string().describe("Column name."),
              type: z.enum(TABLE_DATATYPES).describe("Column data type."),
              mandatory: z.boolean().optional().describe("Whether the column is required."),
              description: z.string().optional(),
            }),
          )
          .min(1)
          .describe("Column definitions."),
        description: z.string().optional().describe("Table description."),
        folder_name: z.string().optional().describe("Folder to place the table in."),
        dry_run: z.boolean().optional().describe("Preview the table design without creating it."),
      },
      annotations: { title: "Create table", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ workspace_id, table_name, columns, description, folder_name, dry_run }) => {
      const tableDesign: Record<string, unknown> = {
        TABLENAME: table_name,
        COLUMNS: columns.map((c) => ({
          COLUMNNAME: c.name,
          DATATYPE: c.type,
          ...(c.mandatory ? { MANDATORY: "true" } : {}),
          ...(c.description ? { DESCRIPTION: c.description } : {}),
        })),
      };
      if (description) tableDesign.TABLEDESCRIPTION = description;
      if (folder_name) tableDesign.FOLDERNAME = folder_name;
      if (dry_run) return ok({ dry_run: true, action: "create_table", workspace_id, tableDesign, note: "Nothing was created." });
      audit("create_table", { workspace_id, table_name, column_count: columns.length });
      return run(() => client.createTable(workspace_id, tableDesign));
    },
  );

  writeTool(
    "zoho_delete_view",
    {
      description:
        "Permanently DELETE a view/table by id from a workspace. Irreversible — removes the view and its data. Use dry_run to confirm the target first.",
      inputSchema: {
        workspace_id: z.string().describe("Workspace id."),
        view_id: z.string().describe("View/table id to delete."),
        dry_run: z.boolean().optional().describe("Confirm the target without deleting anything."),
      },
      annotations: { title: "Delete view", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ workspace_id, view_id, dry_run }) => {
      if (dry_run) return ok({ dry_run: true, action: "delete_view", workspace_id, view_id, note: "Nothing was deleted." });
      audit("delete_view", { workspace_id, view_id });
      return run(() => client.deleteView(workspace_id, view_id));
    },
  );
}
