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
  // Pretty-print small results for readability; large ones (row exports) go
  // compact — indentation roughly doubles the token cost of a 1000-row result.
  const compact = JSON.stringify(data);
  const text = compact.length > 4000 ? compact : JSON.stringify(data, null, 2);
  return { content: [{ type: "text", text }] };
}

// Raw bodies larger than this are refused instead of parsed — a sync export of a
// huge view can otherwise exhaust the Durable Object's memory (the JSON parse +
// row array cost a multiple of the body size). Thrown inside run(), which turns
// it into a tool error.
const MAX_EXPORT_BODY_CHARS = 10_000_000;
function guardExportSize(size: number): void {
  if (size <= MAX_EXPORT_BODY_CHARS) return;
  throw new Error(
    `Export body is ${Math.round(size / 1_000_000)}MB — too large to handle in the Worker. ` +
      `Narrow it with criteria/selected_columns, use LIMIT/OFFSET in SQL (via zoho_query_data), or split the export into criteria ranges — the download endpoint itself has no paging.`,
  );
}

function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Run an API call and normalize errors into a tool error (never throw). */
async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    // Surface failures in `wrangler tail` / Workers Logs too — without this, a
    // failed tool call leaves zero server-side trace for incident debugging.
    try {
      const line =
        err instanceof ZohoAnalyticsError
          ? `${err.method} ${err.path} -> ${err.status}${err.errorCode != null ? ` (errorCode ${err.errorCode})` : ""}`
          : (err instanceof Error ? err.message : String(err)).slice(0, 200);
      console.error(`[zoho-analytics-mcp error] ${line}`);
    } catch {
      /* logging must never break a tool call */
    }
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

/**
 * Is this view a table-like view whose columns can be fetched? Zoho's docs say
 * viewType is a numeric code, but the live API returns NAME strings — accept
 * both (the round-1 fix corrected only the display mapping; the live MCP pass
 * caught this gate still code-only, which silently skipped ALL column fetches).
 */
export const isTabularViewType = (viewType: unknown): boolean => {
  const s = String(viewType ?? "");
  return ["0", "1", "6", "Table", "Tabular View", "Query Table"].includes(s);
};

// Zoho's docs describe viewType as a numeric code, but live responses can carry
// name strings ("Table", "AnalysisView", "Dashboard") — accept both.
export const readableViewType = (code?: string | number): string => {
  const s = String(code ?? "");
  if (VIEW_TYPE_NAMES[s]) return VIEW_TYPE_NAMES[s];
  if (s && /^[A-Za-z][A-Za-z ]*$/.test(s)) return s; // already a readable name
  return `type ${code ?? "unknown"}`;
};

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

// The add-column endpoint additionally accepts DURATION (not valid in create-table designs).
const COLUMN_DATATYPES = [...TABLE_DATATYPES, "DURATION"] as const;

const cellValue = z.union([z.string(), z.number(), z.boolean()]);

export interface RegisterToolsOptions {
  /** The configured org id (shown by zoho_whoami). */
  orgId?: string;
  /** The configured data-center key (shown by zoho_whoami). */
  dc?: string;
  /** When true, write/state-changing tools are not registered at all (reporting-only deploys). */
  readOnly?: boolean;
  /**
   * When true, register only the curated ~26 workhorse tools (MCP_CORE).
   * Smaller tool surface = better tool selection for everyday LLM consumers.
   */
  core?: boolean;
  /** Optional per-tool-call usage hook (tool name + success), e.g. Workers Analytics Engine. */
  track?: (tool: string, ok: boolean) => void;
  /** Optional short-TTL cache for expensive metadata reads (KV-backed). */
  cache?: {
    get(key: string): Promise<string | null>;
    put(key: string, value: string, ttlSecs: number): Promise<void>;
  };
  /** Optional spill store: oversized export bodies become time-limited signed URLs instead of truncation. */
  exportStore?: {
    save(body: string, contentType: string): Promise<{ url: string; expires_at: string }>;
  };
}

/**
 * The curated everyday surface (MCP_CORE=true): discovery, schema, SQL/query,
 * row CRUD, and import — the tools an assistant reaches for daily. Everything
 * else (sharing, users, publish, slides, variables, AutoML, …) stays available
 * on full deploys.
 */
const CORE_TOOLS = new Set([
  "zoho_whoami",
  "zoho_get_orgs",
  "zoho_list_workspaces",
  "zoho_get_workspace_details",
  "zoho_list_views",
  "zoho_get_view_details",
  "zoho_get_view_metadata",
  "zoho_get_metadata",
  "zoho_describe_workspace",
  "zoho_list_folders",
  "zoho_export_data",
  "zoho_query_data",
  "zoho_create_export_job",
  "zoho_get_export_job",
  "zoho_get_import_job",
  "zoho_add_row",
  "zoho_update_rows",
  "zoho_delete_rows",
  "zoho_import_data",
  "zoho_create_table",
  "zoho_create_table_from_data",
  "zoho_create_query_table",
  "zoho_get_query_table",
  "zoho_edit_query_table",
  "zoho_get_dependents",
  "zoho_list_users",
]);

/** Register all Zoho Analytics tools onto the given MCP server. */
export function registerTools(
  server: McpServer,
  client: ZohoAnalyticsClient,
  opts: RegisterToolsOptions = {},
): void {
  // Central registration gate: applies the MCP_CORE filter and wraps every
  // handler with the optional usage hook. Typed as the real method so handler
  // arg inference from the Zod inputSchema is preserved.
  const instrument = (register: McpServer["registerTool"]): McpServer["registerTool"] =>
    ((name: string, cfg: unknown, handler: (...a: unknown[]) => Promise<ToolResult>) => {
      if (opts.core && !CORE_TOOLS.has(name)) return undefined;
      const wrapped = async (...args: unknown[]): Promise<ToolResult> => {
        const out = await handler(...args);
        try {
          opts.track?.(name, out?.isError !== true);
        } catch {
          /* telemetry must never break a tool call */
        }
        return out;
      };
      return register(name as never, cfg as never, wrapped as never);
    }) as McpServer["registerTool"];

  // Reads register through readTool; writes through writeTool — a no-op when the
  // server is read-only (MCP_READONLY), so those tools never appear in tools/list.
  const noop = (() => undefined) as unknown as McpServer["registerTool"];
  const readTool: McpServer["registerTool"] = instrument(
    server.registerTool.bind(server) as McpServer["registerTool"],
  );
  const writeTool: McpServer["registerTool"] = opts.readOnly
    ? noop
    : instrument(server.registerTool.bind(server) as McpServer["registerTool"]);

  // Merge advanced/passthrough CONFIG keys into a base config object. Options
  // merge FIRST: explicit schema-validated params always win, so a passthrough
  // can never override the keys that dry_run/audit/validation were computed from.
  const adv = (base: Record<string, unknown>, options?: Record<string, unknown>) => ({ ...(options ?? {}), ...base });
  const ID = (label: string) => z.string().describe(label);
  const emails = z.array(z.string()).min(1).describe("Email address(es).");
  const advOpt = z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Advanced CONFIG keys merged into the request (see Zoho Analytics API docs for the full list).");

  // ============================ Reads ============================

  readTool(
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

  readTool(
    "zoho_get_orgs",
    {
      description:
        "List the Zoho Analytics organizations this account can access, with each org's id and name. Use the orgId here as the ZANALYTICS-ORGID the server is configured with.",
      inputSchema: {},
      annotations: { title: "Get organizations", ...READ_ONLY },
    },
    async () => run(() => client.getOrgs()),
  );

  readTool(
    "zoho_list_workspaces",
    {
      description:
        "List workspaces (databases). scope: all (default), owned, or shared. Returns compact { workspaceId, workspaceName } entries by default; set verbose=true for the full objects. Workspaces contain the views (tables, query tables, dashboards) you query.",
      inputSchema: {
        scope: z.enum(["all", "owned", "shared"]).optional().describe("Which workspaces to list (default all)."),
        verbose: z.boolean().optional().describe("Return full workspace objects instead of compact id/name."),
      },
      annotations: { title: "List workspaces", ...READ_ONLY },
    },
    async ({ scope, verbose }) =>
      run(async () => {
        const res = (await (scope === "owned"
          ? client.getOwnedWorkspaces()
          : scope === "shared"
            ? client.getSharedWorkspaces()
            : client.getWorkspaces())) as AnyRec;
        const data = res?.data ?? res;
        if (verbose) return data;
        const trim = (ws: AnyRec[] | undefined) =>
          (ws ?? []).map((w) => ({ workspaceId: w.workspaceId, workspaceName: w.workspaceName, isDefault: w.isDefault ?? null }));
        // The scoped endpoints return data.workspaces; only the "all" endpoint
        // splits into ownedWorkspaces/sharedWorkspaces.
        if (scope === "owned" || scope === "shared") {
          return { scope, workspaces: trim(data?.workspaces) };
        }
        return {
          ownedWorkspaces: trim(data?.ownedWorkspaces),
          sharedWorkspaces: trim(data?.sharedWorkspaces),
        };
      }),
  );

  readTool(
    "zoho_get_workspace_details",
    {
      description: "Get details of a single workspace by id (name, description, owner, created time, org).",
      inputSchema: { workspace_id: z.string().describe("Workspace (database) id.") },
      annotations: { title: "Get workspace details", ...READ_ONLY },
    },
    async ({ workspace_id }) => run(() => client.getWorkspaceDetails(workspace_id)),
  );

  readTool(
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
        start_index: z.number().int().min(0).optional().describe("Pagination offset."),
        no_of_result: z.number().int().min(1).optional().describe("Pagination page size."),
        verbose: z.boolean().optional().describe("Return full view objects instead of compact id/name/type."),
      },
      annotations: { title: "List views", ...READ_ONLY },
    },
    async ({ workspace_id, view_types, keyword, start_index, no_of_result, verbose }) =>
      run(async () => {
        const nameToCode: Record<string, number> = {};
        for (const [code, name] of Object.entries(VIEW_TYPE_NAMES)) nameToCode[name] = Number(code);
        const config: Record<string, unknown> = {};
        if (view_types?.length) config.viewTypes = view_types.map((t) => nameToCode[t]).filter((n) => n !== undefined);
        if (keyword) config.keyword = keyword;
        if (start_index != null) config.startIndex = start_index;
        if (no_of_result != null) config.noOfResult = no_of_result;
        const res = (await client.getViews(workspace_id, Object.keys(config).length ? config : undefined)) as AnyRec;
        const views: AnyRec[] = res?.data?.views ?? res?.data ?? [];
        if (verbose) return res?.data ?? res;
        return { count: views.length, views: views.map(compactView) };
      }),
  );

  readTool(
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

  readTool(
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

  readTool(
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
        // Schema maps are expensive (1 + N API calls) and change rarely — serve
        // from the short-TTL cache when available to save API units.
        // v2: busts entries cached before the isTabularViewType fix (those have no columns).
        const cacheKey = `zoho-cache:describe:v2:${workspace_id}:${include_columns !== false}:${max_views ?? 50}`;
        if (opts.cache) {
          try {
            const hit = await opts.cache.get(cacheKey);
            if (hit) return { ...JSON.parse(hit), cached: true };
          } catch {
            /* cache misses must never break the tool */
          }
        }
        const res = (await client.getViews(workspace_id)) as AnyRec;
        const all: AnyRec[] = res?.data?.views ?? res?.data ?? [];
        const views = all.slice(0, max_views ?? 50);
        const wantCols = include_columns !== false;
        const described = await mapLimit(views, concurrency ?? 4, async (v) => {
          const base = compactView(v);
          if (!wantCols || !isTabularViewType(v.viewType) || !v.viewId) return base;
          try {
            const detail = (await client.getViewDetails(String(v.viewId), { withInvolvedMetaInfo: true })) as AnyRec;
            return { ...base, columns: extractColumns(detail) };
          } catch (e) {
            return { ...base, columns: [], columns_error: e instanceof ZohoAnalyticsError ? `API ${e.status}` : String(e) };
          }
        });
        const result = {
          workspace_id,
          view_count: all.length,
          described: described.length,
          truncated: all.length > described.length,
          views: described,
        };
        // Don't pin a transiently-degraded map (a 429/5xx on some per-view column
        // fetch) for 5 minutes — only cache when every described view is clean.
        const allClean = described.every((v) => !("columns_error" in v));
        if (opts.cache && allClean) {
          try {
            await opts.cache.put(cacheKey, JSON.stringify(result), 300);
          } catch {
            /* best-effort */
          }
        }
        return result;
      }),
  );

  readTool(
    "zoho_export_data",
    {
      description:
        "Export the rows of a table/view SYNCHRONOUSLY and return them as parsed rows (response_format=json, default) — the quick way to read a whole table or a filtered slice. Use `criteria` to filter and `selected_columns` to project. NOT allowed for views over 1,000,000 rows, live-connect workspaces, or Dashboard/Query-Table views — use zoho_query_data or zoho_create_export_job for those. NOTE: columns marked PII in Zoho are silently excluded from exports. Caps returned rows at max_rows.",
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
        options: advOpt,
      },
      annotations: { title: "Export view data (sync)", ...READ_ONLY },
    },
    async ({ workspace_id, view_id, criteria, selected_columns, response_format, max_rows, options }) =>
      run(async () => {
        const fmt = (response_format ?? "json") as ResponseFormat;
        const config: Record<string, unknown> = { ...(options ?? {}), responseFormat: fmt };
        if (fmt === "json" && config.keyValueFormat === undefined) config.keyValueFormat = true;
        if (criteria) config.criteria = criteria;
        if (selected_columns?.length) config.selectedColumns = selected_columns;
        const raw = await client.exportData(workspace_id, view_id, config);
        guardExportSize(raw.length);
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

  readTool(
    "zoho_query_data",
    {
      description:
        "Run an ad-hoc SQL SELECT against a workspace and return the result rows. This is the headline analytics tool. Under the hood it creates an async bulk export job from your SQL, polls it to completion, downloads the result, and parses it. ZOHO SQL DIALECT RULES: double-quote ALL table/column names; aggregates (COUNT/SUM/MIN/MAX/AVG) are NOT allowed inside ORDER BY / GROUP BY / WHERE — alias the aggregate in SELECT and order by the alias (SELECT \"Region\", COUNT(*) AS \"N\" FROM \"Orders\" GROUP BY \"Region\" ORDER BY \"N\" DESC); every non-aggregated SELECT column must appear in GROUP BY. NOTE: columns marked PII in Zoho are silently EXCLUDED from exported rows (aggregating on them still works). Jobs routinely take 30-90s; if the wait window is exceeded you get a job_id to continue via zoho_get_export_job. Caps returned rows at max_rows.",
      inputSchema: {
        workspace_id: z.string().describe("Workspace id to run the query against."),
        sql_query: z.string().describe('SQL SELECT. Quote identifiers: SELECT "col" FROM "Table" WHERE ...'),
        max_rows: z.number().int().min(1).max(100000).optional().describe("Max rows to return (default 1000). Also consider LIMIT in SQL."),
        timeout_seconds: z.number().int().min(1).max(120).optional().describe("Approximate max seconds to wait (default 50, cap 120; Zoho jobs routinely take 30-90s)."),
      },
      annotations: { title: "Query data (SQL)", ...READ_ONLY },
    },
    async ({ workspace_id, sql_query, max_rows, timeout_seconds }) =>
      run(async () => {
        const created = (await client.createExportJobBySql(workspace_id, sql_query, "json")) as AnyRec;
        const jobId = created?.data?.jobId ?? created?.jobId;
        if (!jobId) throw new Error(`Export job was not created: ${JSON.stringify(created)}`);
        const deadline = Date.now() + Math.min(timeout_seconds ?? 50, 120) * 1000;
        const interval = 2000;
        for (;;) {
          const st = (await client.getExportJobStatus(workspace_id, String(jobId))) as AnyRec;
          const code = String(st?.data?.jobCode ?? "");
          if (code === JOB_CODE.COMPLETED) break;
          if (code === JOB_CODE.ERROR) {
            throw new Error(`Export job ${jobId} FAILED server-side (jobCode 1003). Details: ${JSON.stringify(st?.data ?? {})}`);
          }
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
        guardExportSize(raw.length);
        const { rows, raw: rawJson } = parseExportRows(raw);
        if (rows.length === 0 && rawJson !== undefined) return { job_id: jobId, done: true, row_count: 0, raw: rawJson.slice(0, 50_000) };
        const { rows: out, truncated, total } = capRows(rows, max_rows ?? 1000);
        // Truncated result + spill store configured -> persist the FULL body and
        // hand back a signed URL so nothing is lost to the inline cap.
        let spill: { url: string; expires_at: string } | undefined;
        if (truncated && opts.exportStore) {
          try {
            spill = await opts.exportStore.save(raw, "application/json");
          } catch {
            /* spill is best-effort; the capped rows still go back */
          }
        }
        return {
          job_id: jobId,
          done: true,
          row_count: total,
          returned: out.length,
          truncated,
          ...(spill ? { full_result_url: spill.url, full_result_expires_at: spill.expires_at } : {}),
          rows: out,
        };
      }),
  );

  readTool(
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
        options: advOpt,
      },
      annotations: { title: "Create export job (async)", readOnlyHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ workspace_id, sql_query, view_id, response_format, criteria, options }) =>
      run(async () => {
        const fmt = (response_format ?? "csv") as ResponseFormat;
        if (!sql_query && !view_id) throw new Error("Provide either sql_query or view_id.");
        if (sql_query && view_id) throw new Error("Provide only one of sql_query or view_id, not both.");
        const res = sql_query
          ? ((await client.createExportJobBySql(workspace_id, sql_query, fmt, options)) as AnyRec)
          : ((await client.createExportJobByView(
              workspace_id,
              view_id!,
              adv({ responseFormat: fmt, ...(criteria ? { criteria } : {}) }, options),
            )) as AnyRec);
        return { job_id: res?.data?.jobId ?? res?.jobId ?? null, raw: res?.data ?? res };
      }),
  );

  readTool(
    "zoho_get_export_job",
    {
      description:
        "Check an asynchronous export job's status (jobCode 1001/1002 = running, 1003 = FAILED server-side, 1004 = done, 1005 = invalid). Set download=true to also fetch the data once the job is complete — returns parsed rows for json exports or raw text for csv.",
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
        const status = {
          job_id,
          job_code: code,
          done: code === JOB_CODE.COMPLETED,
          failed: code === JOB_CODE.ERROR,
          ...(code === JOB_CODE.ERROR ? { note: "Job failed server-side (jobCode 1003) — stop polling; see detail for the error." } : {}),
          detail: st?.data ?? st,
        };
        if (!download || code !== JOB_CODE.COMPLETED) return status;
        const raw = await client.downloadExportData(workspace_id, job_id);
        guardExportSize(raw.length);
        const { rows, raw: rawJson } = parseExportRows(raw);
        const saveSpill = async (body: string, ct: string) => {
          if (!opts.exportStore) return undefined;
          try {
            return await opts.exportStore.save(body, ct);
          } catch {
            return undefined;
          }
        };
        if (rows.length === 0 && rawJson === undefined) {
          // Parsed JSON with genuinely zero rows.
          return { ...status, row_count: 0, rows: [] };
        }
        if (rows.length === 0) {
          // CSV (or unrecognized) — return raw text, capped; spill the full body when capped.
          const text = rawJson ?? raw;
          const capped = text.length > 100_000;
          const spill = capped ? await saveSpill(text, "text/csv") : undefined;
          return {
            ...status,
            data: text.slice(0, 100_000),
            truncated_chars: capped,
            ...(spill ? { full_result_url: spill.url, full_result_expires_at: spill.expires_at } : {}),
          };
        }
        const { rows: out, truncated, total } = capRows(rows, max_rows ?? 1000);
        const spill = truncated ? await saveSpill(raw, "application/json") : undefined;
        return {
          ...status,
          row_count: total,
          returned: out.length,
          truncated,
          ...(spill ? { full_result_url: spill.url, full_result_expires_at: spill.expires_at } : {}),
          rows: out,
        };
      }),
  );

  readTool(
    "zoho_get_import_job",
    {
      description:
        "Check an asynchronous import job's status and summary (jobCode 1001/1002 = running, 1003 = FAILED server-side, 1004 = done, 1005 = invalid; jobInfo.importSummary has totalRowCount / successRowCount / warnings). Use after zoho_import_data when you didn't wait inline.",
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
      if (criteria && update_all_rows) {
        return fail("Pass either `criteria` OR update_all_rows=true — not both (ambiguous: all-rows would override the filter).");
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
      if (criteria && delete_all_rows) {
        return fail("Pass either `criteria` OR delete_all_rows=true — not both (ambiguous).");
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
        "Bulk-import data (CSV or JSON text) into an existing table. import_type: 'append' (add rows), 'truncateadd' (REPLACE all data), or 'updateadd' (upsert — requires matching_columns). mode: 'async' (default — job; waits and returns the summary unless wait=false), 'sync' (inline result, small files), or 'batch' (chunked async job). Preview with dry_run.",
      inputSchema: {
        workspace_id: z.string().describe("Workspace id."),
        view_id: z.string().describe("Target table id."),
        data: z.string().describe("The file content to import (CSV or JSON text)."),
        file_type: z.enum(["csv", "json"]).optional().describe("Format of `data` (default csv)."),
        import_type: z.enum(["append", "truncateadd", "updateadd"]).optional().describe("How to import (default append). truncateadd REPLACES all rows."),
        mode: z.enum(["async", "sync", "batch"]).optional().describe("async job (default), sync inline, or batch (chunked job)."),
        matching_columns: z.array(z.string()).optional().describe("Key columns for updateadd (upsert). Required when import_type=updateadd."),
        auto_identify: z.boolean().optional().describe("Auto-identify column data types (default true)."),
        on_error: z.enum(["abort", "skiprow", "setcolumnempty"]).optional().describe("Behavior on a bad row (default abort)."),
        options: advOpt,
        wait: z.boolean().optional().describe("Wait for the job to complete and return its summary (default true)."),
        timeout_seconds: z.number().int().min(1).max(60).optional().describe("Approximate max seconds to wait when wait=true (default 30, cap 60; a slow status call can overrun slightly)."),
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
      const mode = a.mode ?? "async";
      if (a.data.length > 25_000_000) {
        return fail(
          `Import payload is ${Math.round(a.data.length / 1_000_000)}MB — too large to pass through the Worker as a tool argument. Split the file and import in chunks (mode=async, import_type=append).`,
        );
      }
      if (a.dry_run) {
        return ok({
          dry_run: true,
          action: "import_data",
          view_id: a.view_id,
          file_type: fileType,
          import_type: importType,
          mode,
          bytes: a.data.length,
          note: importType === "truncateadd" ? "Would REPLACE all existing rows. Nothing was imported." : "Nothing was imported.",
        });
      }
      audit("import_data", { workspace_id: a.workspace_id, view_id: a.view_id, import_type: importType, mode, bytes: a.data.length });
      // options merges FIRST so it can never override the validated safety keys
      // (importType etc.) that dry_run/audit/validation were computed from.
      const config: Record<string, unknown> = {
        ...(a.options ?? {}),
        importType,
        fileType,
        autoIdentify: String(a.auto_identify ?? true),
        onError: a.on_error ?? "abort",
      };
      if (a.matching_columns?.length) config.matchingColumns = a.matching_columns;
      const file = { content: a.data, name: `import.${fileType}`, type: fileType === "json" ? "application/json" : "text/csv" };
      if (mode === "sync") {
        return run(() => client.importDataSync(a.workspace_id, a.view_id, file, config));
      }
      return run(async () => {
        const created = (await (mode === "batch"
          ? client.createBatchImportJob(a.workspace_id, a.view_id, file, config)
          : client.createImportJob(a.workspace_id, a.view_id, file, config))) as AnyRec;
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
          if (code === JOB_CODE.ERROR) {
            throw new Error(`Import job ${jobId} FAILED server-side (jobCode 1003). Details: ${JSON.stringify(st?.data ?? {})}`);
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
        "Delete a view/table by id — moves it to the workspace TRASH (recoverable with zoho_restore_view; permanently erase it with zoho_delete_trash_view). Dependent views may be affected. Use dry_run to confirm the target first.",
      inputSchema: {
        workspace_id: z.string().describe("Workspace id."),
        view_id: z.string().describe("View/table id to delete."),
        dry_run: z.boolean().optional().describe("Confirm the target without deleting anything."),
      },
      annotations: { title: "Delete view (move to trash)", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ workspace_id, view_id, dry_run }) => {
      if (dry_run) return ok({ dry_run: true, action: "delete_view", workspace_id, view_id, note: "Nothing was deleted." });
      audit("delete_view", { workspace_id, view_id });
      return run(() => client.deleteView(workspace_id, view_id));
    },
  );

  // ============================ Discovery (reads) ============================

  readTool(
    "zoho_list_folders",
    {
      description: "List the folders in a workspace (folders group views).",
      inputSchema: { workspace_id: ID("Workspace id.") },
      annotations: { title: "List folders", ...READ_ONLY },
    },
    async ({ workspace_id }) => run(() => client.getFolders(workspace_id)),
  );

  readTool(
    "zoho_list_dashboards",
    {
      description: "List dashboards across the org. scope: all (default), owned, or shared.",
      inputSchema: { scope: z.enum(["all", "owned", "shared"]).optional().describe("Which dashboards to list (default all).") },
      annotations: { title: "List dashboards", ...READ_ONLY },
    },
    async ({ scope }) =>
      run(() =>
        scope === "owned" ? client.getOwnedDashboards() : scope === "shared" ? client.getSharedDashboards() : client.getDashboards(),
      ),
  );

  readTool(
    "zoho_list_recent_views",
    {
      description: "List recently accessed views.",
      inputSchema: {},
      annotations: { title: "List recent views", ...READ_ONLY },
    },
    async () => run(() => client.getRecentViews()),
  );

  readTool(
    "zoho_get_view_metadata",
    {
      description:
        "Get ONLY the column list of a table (names, columnId values, data types) via the workspace-scoped metadata endpoint. Use this when you need columnId values for the column tools (rename/delete/hide/lookup). For general view info (type, description, plus columns), prefer zoho_get_view_details.",
      inputSchema: { workspace_id: ID("Workspace id."), view_id: ID("View id.") },
      annotations: { title: "Get view metadata", ...READ_ONLY },
    },
    async ({ workspace_id, view_id }) => run(() => client.getViewMetadata(workspace_id, view_id)),
  );

  readTool(
    "zoho_get_trash",
    {
      description:
        "List the views currently in a workspace's trash (with who/when deleted). Restore with zoho_restore_view (a write tool — absent on read-only deploys).",
      inputSchema: { workspace_id: ID("Workspace id.") },
      annotations: { title: "Get trash", ...READ_ONLY },
    },
    async ({ workspace_id }) => run(() => client.getTrashViews(workspace_id)),
  );

  readTool(
    "zoho_list_datasources",
    {
      description: "List a workspace's data sources (sync status, schedule, the tables each feeds).",
      inputSchema: { workspace_id: ID("Workspace id.") },
      annotations: { title: "List datasources", ...READ_ONLY },
    },
    async ({ workspace_id }) => run(() => client.getDatasources(workspace_id)),
  );

  // ============================ Modeling: query tables & reports ============================

  writeTool(
    "zoho_create_query_table",
    {
      description: "Create a query table — a saved, SQL-backed view you can read like any table. Provide the SQL and a name.",
      inputSchema: {
        workspace_id: ID("Workspace id."),
        sql_query: z.string().describe('SQL SELECT, with quoted identifiers: SELECT "col" FROM "Table".'),
        query_table_name: z.string().describe("Name for the new query table."),
        description: z.string().optional(),
        folder_id: z.string().optional(),
      },
      annotations: { title: "Create query table", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ workspace_id, sql_query, query_table_name, description, folder_id }) => {
      audit("create_query_table", { workspace_id, query_table_name });
      return run(() =>
        client.createQueryTable(workspace_id, {
          sqlQuery: sql_query,
          queryTableName: query_table_name,
          ...(description ? { description } : {}),
          ...(folder_id ? { folderId: folder_id } : {}),
        }),
      );
    },
  );

  readTool(
    "zoho_get_query_table",
    {
      description: "Get a query table's details, including its CURRENT SQL — read this before zoho_edit_query_table, which overwrites the SQL completely.",
      inputSchema: { workspace_id: ID("Workspace id."), query_table_id: ID("Query table view id.") },
      annotations: { title: "Get query table", ...READ_ONLY },
    },
    async ({ workspace_id, query_table_id }) => run(() => client.getQueryTableDetails(workspace_id, query_table_id)),
  );

  writeTool(
    "zoho_edit_query_table",
    {
      description:
        "Edit an existing query table's SQL (and optionally move it to a folder). This REPLACES the whole SQL — read the current SQL first with zoho_get_query_table.",
      inputSchema: {
        workspace_id: ID("Workspace id."),
        query_table_id: ID("Query table view id."),
        sql_query: z.string().describe("New SQL SELECT."),
        folder_id: z.string().optional(),
      },
      annotations: { title: "Edit query table", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ workspace_id, query_table_id, sql_query, folder_id }) =>
      run(() => client.editQueryTable(workspace_id, query_table_id, { sqlQuery: sql_query, ...(folder_id ? { folderId: folder_id } : {}) })),
  );

  writeTool(
    "zoho_create_report",
    {
      description:
        "Create a report (chart / pivot / summary) over a base table. report_type is chart|pivot|summary; for charts also pass chart_type (e.g. 'bar','line','pie'). axis_columns describes the axes — each item { type, columnName, operation } (chart types: xAxis/yAxis/...; pivot: row/column/data; summary: groupBy/summarize). Use options for filters/userFilters/merge settings.",
      inputSchema: {
        workspace_id: ID("Workspace id."),
        base_table_name: z.string().describe("Name of the base table to report on."),
        title: z.string().describe("Report title."),
        report_type: z.enum(["chart", "pivot", "summary"]).describe("Kind of report."),
        chart_type: z.string().optional().describe("Chart type (required for report_type=chart), e.g. bar, line, pie, scatter."),
        axis_columns: z.array(z.record(z.string(), z.unknown())).describe("Axis definitions: [{ type, columnName, operation }]."),
        description: z.string().optional(),
        options: advOpt,
      },
      annotations: { title: "Create report", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ workspace_id, base_table_name, title, report_type, chart_type, axis_columns, description, options }) => {
      audit("create_report", { workspace_id, report_type });
      return run(() =>
        client.createReport(
          workspace_id,
          adv(
            {
              baseTableName: base_table_name,
              title,
              reportType: report_type,
              ...(chart_type ? { chartType: chart_type } : {}),
              axisColumns: axis_columns,
              ...(description ? { description } : {}),
            },
            options,
          ),
        ),
      );
    },
  );

  writeTool(
    "zoho_update_report",
    {
      description:
        "Update an existing report's axes (and optionally title/type). axis_columns is REQUIRED by the API even for a rename — pass the full current axis definition; use options for filters and merge settings.",
      inputSchema: {
        workspace_id: ID("Workspace id."),
        report_id: ID("Report view id."),
        axis_columns: z.array(z.record(z.string(), z.unknown())).min(1).describe("Full axis definition (required by the API on every update)."),
        title: z.string().optional(),
        report_type: z.enum(["chart", "pivot", "summary"]).optional(),
        options: advOpt,
      },
      annotations: { title: "Update report", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ workspace_id, report_id, title, report_type, axis_columns, options }) =>
      run(() =>
        client.updateReport(
          workspace_id,
          report_id,
          adv(
            {
              ...(title ? { title } : {}),
              ...(report_type ? { reportType: report_type } : {}),
              ...(axis_columns ? { axisColumns: axis_columns } : {}),
            },
            options,
          ),
        ),
      ),
  );

  // ============================ Modeling: columns ============================

  writeTool(
    "zoho_add_column",
    {
      description:
        "Add a column to a table. data_type is one of PLAIN, MULTI_LINE, EMAIL, NUMBER, POSITIVE_NUMBER, DECIMAL_NUMBER, CURRENCY, PERCENT, DATE, BOOLEAN, URL, AUTO_NUMBER, GEO, DURATION. For GEO pass geo_role (0-8).",
      inputSchema: {
        workspace_id: ID("Workspace id."),
        view_id: ID("Table id."),
        column_name: z.string().describe("New column name."),
        data_type: z.enum(COLUMN_DATATYPES).describe("Column data type."),
        is_pii: z.boolean().optional().describe("Mark as a PII column."),
        geo_role: z.number().int().min(0).max(8).optional().describe("Geo role (required when data_type=GEO)."),
      },
      annotations: { title: "Add column", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ workspace_id, view_id, column_name, data_type, is_pii, geo_role }) =>
      run(() =>
        client.addColumn(workspace_id, view_id, {
          columnName: column_name,
          dataType: data_type,
          ...(is_pii != null ? { isPIIColumn: is_pii } : {}),
          ...(geo_role != null ? { geoRole: geo_role } : {}),
        }),
      ),
  );

  writeTool(
    "zoho_rename_column",
    {
      description: "Rename a column.",
      inputSchema: {
        workspace_id: ID("Workspace id."),
        view_id: ID("Table id."),
        column_id: ID("Column id."),
        column_name: z.string().describe("New column name."),
      },
      annotations: { title: "Rename column", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ workspace_id, view_id, column_id, column_name }) =>
      run(() => client.renameColumn(workspace_id, view_id, column_id, { columnName: column_name })),
  );

  writeTool(
    "zoho_delete_column",
    {
      description: "Delete a column. Set delete_dependent_views=true to also remove views that depend on it. Irreversible.",
      inputSchema: {
        workspace_id: ID("Workspace id."),
        view_id: ID("Table id."),
        column_id: ID("Column id."),
        delete_dependent_views: z.boolean().optional(),
        dry_run: z.boolean().optional(),
      },
      annotations: { title: "Delete column", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ workspace_id, view_id, column_id, delete_dependent_views, dry_run }) => {
      if (dry_run) return ok({ dry_run: true, action: "delete_column", view_id, column_id, delete_dependent_views: !!delete_dependent_views, note: "Nothing was deleted." });
      audit("delete_column", { workspace_id, view_id, column_id, cascade: !!delete_dependent_views });
      return run(() =>
        client.deleteColumn(workspace_id, view_id, column_id, delete_dependent_views ? { deleteDependentViews: true } : undefined),
      );
    },
  );

  writeTool(
    "zoho_hide_columns",
    {
      description: "Hide one or more columns in a table.",
      inputSchema: { workspace_id: ID("Workspace id."), view_id: ID("Table id."), column_ids: z.array(z.string()).min(1) },
      annotations: { title: "Hide columns", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ workspace_id, view_id, column_ids }) => run(() => client.hideColumns(workspace_id, view_id, column_ids)),
  );

  writeTool(
    "zoho_show_columns",
    {
      description: "Un-hide one or more columns in a table.",
      inputSchema: { workspace_id: ID("Workspace id."), view_id: ID("Table id."), column_ids: z.array(z.string()).min(1) },
      annotations: { title: "Show columns", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ workspace_id, view_id, column_ids }) => run(() => client.showColumns(workspace_id, view_id, column_ids)),
  );

  writeTool(
    "zoho_reorder_columns",
    {
      description: "Reorder a table's columns. `columns` must list ALL column ids in the desired left-to-right order.",
      inputSchema: { workspace_id: ID("Workspace id."), view_id: ID("Table id."), columns: z.array(z.string()).min(1).describe("All column ids, in order.") },
      annotations: { title: "Reorder columns", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ workspace_id, view_id, columns }) => run(() => client.reorderColumns(workspace_id, view_id, columns)),
  );

  writeTool(
    "zoho_add_lookup",
    {
      description: "Add a lookup from a column to a column in another table (creates a relationship).",
      inputSchema: {
        workspace_id: ID("Workspace id."),
        view_id: ID("Table id (the child)."),
        column_id: ID("Column id to turn into a lookup."),
        reference_view_id: ID("Referenced table id."),
        reference_column_id: ID("Referenced column id."),
      },
      annotations: { title: "Add lookup", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ workspace_id, view_id, column_id, reference_view_id, reference_column_id }) =>
      run(() => client.addLookup(workspace_id, view_id, column_id, { referenceViewId: reference_view_id, referenceColumnId: reference_column_id })),
  );

  writeTool(
    "zoho_remove_lookup",
    {
      description: "Remove a lookup relationship from a column. delete_dependent_views=true also removes every dependent view — preview with dry_run.",
      inputSchema: {
        workspace_id: ID("Workspace id."),
        view_id: ID("Table id."),
        column_id: ID("Column id."),
        delete_dependent_views: z.boolean().optional(),
        dry_run: z.boolean().optional(),
      },
      annotations: { title: "Remove lookup", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ workspace_id, view_id, column_id, delete_dependent_views, dry_run }) => {
      if (dry_run) return ok({ dry_run: true, action: "remove_lookup", column_id, delete_dependent_views: !!delete_dependent_views, note: "Nothing was removed." });
      audit("remove_lookup", { workspace_id, view_id, column_id, cascade: !!delete_dependent_views });
      return run(() => client.removeLookup(workspace_id, view_id, column_id, delete_dependent_views ? { deleteDependentViews: true } : undefined));
    },
  );

  // ============================ Modeling: formulas ============================

  writeTool(
    "zoho_add_formula_column",
    {
      description: "Add an inline formula column. Provide a name and a Zoho Analytics formula expression.",
      inputSchema: {
        workspace_id: ID("Workspace id."),
        view_id: ID("Table id."),
        formula_name: z.string(),
        expression: z.string().describe("Formula expression."),
        description: z.string().optional(),
      },
      annotations: { title: "Add formula column", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ workspace_id, view_id, formula_name, expression, description }) =>
      run(() => client.addFormulaColumn(workspace_id, view_id, { formulaName: formula_name, expression, ...(description ? { description } : {}) })),
  );

  writeTool(
    "zoho_delete_formula_column",
    {
      description: "Delete an inline formula column by its formula id. delete_dependent_views=true also removes every dependent view — preview with dry_run.",
      inputSchema: {
        workspace_id: ID("Workspace id."),
        view_id: ID("Table id."),
        formula_id: ID("Formula id."),
        delete_dependent_views: z.boolean().optional(),
        dry_run: z.boolean().optional(),
      },
      annotations: { title: "Delete formula column", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ workspace_id, view_id, formula_id, delete_dependent_views, dry_run }) => {
      if (dry_run) return ok({ dry_run: true, action: "delete_formula_column", formula_id, delete_dependent_views: !!delete_dependent_views, note: "Nothing was deleted." });
      audit("delete_formula_column", { workspace_id, view_id, formula_id, cascade: !!delete_dependent_views });
      return run(() => client.deleteFormulaColumn(workspace_id, view_id, formula_id, delete_dependent_views ? { deleteDependentViews: true } : undefined));
    },
  );

  writeTool(
    "zoho_add_aggregate_formula",
    {
      description: "Add an aggregate formula to a table. Provide a name and an aggregate expression.",
      inputSchema: {
        workspace_id: ID("Workspace id."),
        view_id: ID("Table id."),
        formula_name: z.string(),
        expression: z.string().describe("Aggregate formula expression."),
        description: z.string().optional(),
      },
      annotations: { title: "Add aggregate formula", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ workspace_id, view_id, formula_name, expression, description }) =>
      run(() => client.addAggregateFormula(workspace_id, view_id, { formulaName: formula_name, expression, ...(description ? { description } : {}) })),
  );

  writeTool(
    "zoho_delete_aggregate_formula",
    {
      description: "Delete an aggregate formula by its id. delete_dependent_views=true also removes every dependent view — preview with dry_run.",
      inputSchema: {
        workspace_id: ID("Workspace id."),
        view_id: ID("Table id."),
        formula_id: ID("Formula id."),
        delete_dependent_views: z.boolean().optional(),
        dry_run: z.boolean().optional(),
      },
      annotations: { title: "Delete aggregate formula", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ workspace_id, view_id, formula_id, delete_dependent_views, dry_run }) => {
      if (dry_run) return ok({ dry_run: true, action: "delete_aggregate_formula", formula_id, delete_dependent_views: !!delete_dependent_views, note: "Nothing was deleted." });
      audit("delete_aggregate_formula", { workspace_id, view_id, formula_id, cascade: !!delete_dependent_views });
      return run(() => client.deleteAggregateFormula(workspace_id, view_id, formula_id, delete_dependent_views ? { deleteDependentViews: true } : undefined));
    },
  );

  // ============================ Modeling: folders ============================

  writeTool(
    "zoho_create_folder",
    {
      description: "Create a folder in a workspace.",
      inputSchema: {
        workspace_id: ID("Workspace id."),
        folder_name: z.string(),
        folder_desc: z.string().optional(),
        parent_folder_id: z.string().optional().describe("Make this a sub-folder of the given folder."),
        make_default: z.boolean().optional(),
      },
      annotations: { title: "Create folder", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ workspace_id, folder_name, folder_desc, parent_folder_id, make_default }) =>
      run(() =>
        client.createFolder(workspace_id, {
          folderName: folder_name,
          ...(folder_desc ? { folderDesc: folder_desc } : {}),
          ...(parent_folder_id ? { parentFolderId: parent_folder_id } : {}),
          ...(make_default ? { makeDefaultFolder: true } : {}),
        }),
      ),
  );

  writeTool(
    "zoho_rename_folder",
    {
      description: "Rename a folder (and optionally change its description).",
      inputSchema: { workspace_id: ID("Workspace id."), folder_id: ID("Folder id."), folder_name: z.string(), folder_desc: z.string().optional() },
      annotations: { title: "Rename folder", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ workspace_id, folder_id, folder_name, folder_desc }) =>
      run(() => client.renameFolder(workspace_id, folder_id, { folderName: folder_name, ...(folder_desc ? { folderDesc: folder_desc } : {}) })),
  );

  writeTool(
    "zoho_delete_folder",
    {
      description: "Delete a folder. Set delete_dependent_views=true to also remove dependent views. Irreversible.",
      inputSchema: { workspace_id: ID("Workspace id."), folder_id: ID("Folder id."), delete_dependent_views: z.boolean().optional(), dry_run: z.boolean().optional() },
      annotations: { title: "Delete folder", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ workspace_id, folder_id, delete_dependent_views, dry_run }) => {
      if (dry_run) return ok({ dry_run: true, action: "delete_folder", folder_id, delete_dependent_views: !!delete_dependent_views, note: "Nothing was deleted." });
      audit("delete_folder", { workspace_id, folder_id, cascade: !!delete_dependent_views });
      return run(() => client.deleteFolder(workspace_id, folder_id, delete_dependent_views ? { deleteDependentViews: true } : undefined));
    },
  );

  // ============================ Modeling: view lifecycle ============================

  writeTool(
    "zoho_rename_view",
    {
      description: "Rename a view/table (and optionally change its description).",
      inputSchema: { workspace_id: ID("Workspace id."), view_id: ID("View id."), view_name: z.string(), view_desc: z.string().optional() },
      annotations: { title: "Rename view", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ workspace_id, view_id, view_name, view_desc }) =>
      run(() => client.renameView(workspace_id, view_id, { viewName: view_name, ...(view_desc ? { viewDesc: view_desc } : {}) })),
  );

  writeTool(
    "zoho_save_as_view",
    {
      description: "Copy a view to a new view (optionally with its data and/or lookups, into a folder).",
      inputSchema: {
        workspace_id: ID("Workspace id."),
        view_id: ID("Source view id."),
        view_name: z.string().describe("Name for the copy."),
        copy_with_data: z.boolean().optional(),
        copy_with_lookup: z.boolean().optional(),
        folder_id: z.string().optional(),
      },
      annotations: { title: "Save as (copy view)", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ workspace_id, view_id, view_name, copy_with_data, copy_with_lookup, folder_id }) =>
      run(() =>
        client.saveAsView(workspace_id, view_id, {
          viewName: view_name,
          ...(copy_with_data != null ? { copyWithData: copy_with_data } : {}),
          ...(copy_with_lookup != null ? { copyWithLookup: copy_with_lookup } : {}),
          ...(folder_id ? { folderId: folder_id } : {}),
        }),
      ),
  );

  writeTool(
    "zoho_move_views_to_folder",
    {
      description: "Move one or more views into a folder.",
      inputSchema: { workspace_id: ID("Workspace id."), folder_id: ID("Destination folder id."), view_ids: z.array(z.string()).min(1) },
      annotations: { title: "Move views to folder", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ workspace_id, folder_id, view_ids }) => run(() => client.moveViewsToFolder(workspace_id, { folderId: folder_id, viewIds: view_ids })),
  );

  writeTool(
    "zoho_restore_view",
    {
      description: "Restore a view from the trash. Set with_dependents=true to also restore dependent views.",
      inputSchema: { workspace_id: ID("Workspace id."), view_id: ID("View id (from zoho_get_trash)."), with_dependents: z.boolean().optional() },
      annotations: { title: "Restore view from trash", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ workspace_id, view_id, with_dependents }) =>
      run(() => client.restoreTrashView(workspace_id, view_id, with_dependents ? { withDependents: true } : undefined)),
  );

  writeTool(
    "zoho_delete_trash_view",
    {
      description: "PERMANENTLY delete a view that is already in the trash. Irreversible.",
      inputSchema: { workspace_id: ID("Workspace id."), view_id: ID("View id."), with_dependents: z.boolean().optional(), dry_run: z.boolean().optional() },
      annotations: { title: "Delete trash view (permanent)", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ workspace_id, view_id, with_dependents, dry_run }) => {
      if (dry_run) return ok({ dry_run: true, action: "delete_trash_view", view_id, with_dependents: !!with_dependents, note: "Nothing was deleted." });
      audit("delete_trash_view", { workspace_id, view_id, cascade: !!with_dependents });
      return run(() => client.deleteTrashView(workspace_id, view_id, with_dependents ? { withDependents: true } : undefined));
    },
  );

  writeTool(
    "zoho_sort_data",
    {
      description:
        "Sort a view's stored data by one or more columns. Pass column IDS (get them from zoho_get_view_metadata), not names. sort_order 1=ascending, 2=descending. Set reset=true (columns omitted) to clear sorting.",
      inputSchema: {
        workspace_id: ID("Workspace id."),
        view_id: ID("Table id."),
        columns: z.array(z.string()).optional().describe("Column IDs to sort by (from zoho_get_view_metadata). Required unless reset=true."),
        sort_order: z.number().int().min(1).max(2).optional().describe("1=ascending (default), 2=descending."),
        reset: z.boolean().optional().describe("Clear the stored sort instead of setting one."),
      },
      annotations: { title: "Sort data", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ workspace_id, view_id, columns, sort_order, reset }) => {
      if (reset) return run(() => client.sortData(workspace_id, view_id, { resetSort: true }));
      if (!columns?.length) return fail("Provide `columns` (column IDs) to sort by, or reset=true to clear sorting.");
      return run(() => client.sortData(workspace_id, view_id, { columns, sortOrder: sort_order ?? 1 }));
    },
  );

  writeTool(
    "zoho_create_table_from_data",
    {
      description:
        "Create a NEW table in a workspace from uploaded CSV/JSON text (Zoho infers the columns). mode: 'async' job (default — returns a job_id to poll with zoho_get_import_job), 'sync' inline (small files), or 'batch' (chunked async job).",
      inputSchema: {
        workspace_id: ID("Workspace id."),
        table_name: z.string().describe("Name for the new table."),
        data: z.string().describe("File content (CSV or JSON text)."),
        file_type: z.enum(["csv", "json"]).optional().describe("Format of `data` (default csv)."),
        auto_identify: z.boolean().optional().describe("Auto-identify column data types (default true)."),
        mode: z.enum(["async", "sync", "batch"]).optional().describe("async job (default), sync inline, or batch (chunked job)."),
        options: advOpt,
      },
      annotations: { title: "Create table from data", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ workspace_id, table_name, data, file_type, auto_identify, mode, options }) => {
      const fileType = file_type ?? "csv";
      audit("create_table_from_data", { workspace_id, table_name, mode: mode ?? "async", bytes: data.length });
      const file = { content: data, name: `${table_name}.${fileType}`, type: fileType === "json" ? "application/json" : "text/csv" };
      const config = adv({ tableName: table_name, fileType, autoIdentify: String(auto_identify ?? true) }, options);
      return run(() =>
        mode === "sync"
          ? client.importDataSyncNewTable(workspace_id, file, config)
          : mode === "batch"
            ? client.createBatchImportJobNewTable(workspace_id, file, config)
            : client.createTableFromData(workspace_id, file, config),
      );
    },
  );

  // ============================ Workspace admin ============================

  writeTool(
    "zoho_rename_workspace",
    {
      description: "Rename a workspace (and optionally change its description).",
      inputSchema: { workspace_id: ID("Workspace id."), workspace_name: z.string(), workspace_desc: z.string().optional() },
      annotations: { title: "Rename workspace", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ workspace_id, workspace_name, workspace_desc }) =>
      run(() => client.renameWorkspace(workspace_id, { workspaceName: workspace_name, ...(workspace_desc ? { workspaceDesc: workspace_desc } : {}) })),
  );

  writeTool(
    "zoho_delete_workspace",
    {
      description: "PERMANENTLY delete a workspace and everything in it. Workspaces are not trashed — this is irreversible. Always dry_run first.",
      inputSchema: { workspace_id: ID("Workspace id."), dry_run: z.boolean().optional() },
      annotations: { title: "Delete workspace (permanent)", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ workspace_id, dry_run }) => {
      if (dry_run) return ok({ dry_run: true, action: "delete_workspace", workspace_id, note: "Nothing was deleted." });
      audit("delete_workspace", { workspace_id });
      return run(() => client.deleteWorkspace(workspace_id));
    },
  );

  writeTool(
    "zoho_copy_workspace",
    {
      description: "Copy a workspace to a new one. For a cross-org copy, pass dest_org_id and the source workspace_key (from zoho_get_workspace_secret_key).",
      inputSchema: {
        workspace_id: ID("Source workspace id."),
        new_workspace_name: z.string(),
        new_workspace_desc: z.string().optional(),
        copy_with_data: z.boolean().optional(),
        dest_org_id: z.string().optional().describe("Destination org id (cross-org copy)."),
        workspace_key: z.string().optional().describe("Source workspace secret key (cross-org copy)."),
      },
      annotations: { title: "Copy workspace", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ workspace_id, new_workspace_name, new_workspace_desc, copy_with_data, dest_org_id, workspace_key }) => {
      audit("copy_workspace", { workspace_id, dest_org_id: dest_org_id ?? null });
      return run(() =>
        client.copyWorkspace(
          workspace_id,
          {
            newWorkspaceName: new_workspace_name,
            ...(new_workspace_desc ? { newWorkspaceDesc: new_workspace_desc } : {}),
            ...(copy_with_data != null ? { copyWithData: copy_with_data } : {}),
            ...(workspace_key ? { workspaceKey: workspace_key } : {}),
          },
          dest_org_id,
        ),
      );
    },
  );

  readTool(
    "zoho_get_workspace_secret_key",
    {
      description:
        "Get a workspace's CURRENT secret key (used to authorize cross-org copies). Read-only — rotation is a separate write tool (zoho_regenerate_workspace_secret_key), absent on read-only deploys.",
      inputSchema: { workspace_id: ID("Workspace id.") },
      annotations: { title: "Get workspace secret key", ...READ_ONLY },
    },
    async ({ workspace_id }) => run(() => client.getWorkspaceSecretKey(workspace_id)),
  );

  writeTool(
    "zoho_regenerate_workspace_secret_key",
    {
      description:
        "ROTATE a workspace's secret key — generates a new key and INVALIDATES the old one (anything still using the old key for cross-org copies breaks). Returns the new key.",
      inputSchema: { workspace_id: ID("Workspace id."), dry_run: z.boolean().optional() },
      annotations: { title: "Regenerate workspace secret key", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ workspace_id, dry_run }) => {
      if (dry_run) return ok({ dry_run: true, action: "regenerate_workspace_secret_key", workspace_id, note: "Would rotate the key, invalidating the old one. Nothing was changed." });
      audit("regenerate_workspace_secret_key", { workspace_id });
      return run(() => client.getWorkspaceSecretKey(workspace_id, { regenerateKey: true }));
    },
  );

  writeTool(
    "zoho_copy_views",
    {
      description: "Copy views to another workspace (and optionally another org). dest_org_id is required; pass workspace_key for cross-org.",
      inputSchema: {
        workspace_id: ID("Source workspace id."),
        view_ids: z.array(z.string()).min(1),
        dest_workspace_id: ID("Destination workspace id."),
        dest_org_id: ID("Destination org id."),
        copy_with_data: z.boolean().optional(),
        workspace_key: z.string().optional(),
      },
      annotations: { title: "Copy views", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ workspace_id, view_ids, dest_workspace_id, dest_org_id, copy_with_data, workspace_key }) =>
      run(() =>
        client.copyViews(
          workspace_id,
          {
            viewIds: view_ids,
            destWorkspaceId: dest_workspace_id,
            ...(copy_with_data != null ? { copyWithData: copy_with_data } : {}),
            ...(workspace_key ? { workspaceKey: workspace_key } : {}),
          },
          dest_org_id,
        ),
      ),
  );

  // ============================ Sharing ============================

  readTool(
    "zoho_get_shared_details",
    {
      description:
        "Get sharing details: who views are shared with and what permissions. Pass view_ids for specific views, or omit it for the WHOLE workspace's sharing info (users, groups, public and private-link shares).",
      inputSchema: { workspace_id: ID("Workspace id."), view_ids: z.array(z.string()).optional().describe("Specific views; omit for workspace-wide sharing info.") },
      annotations: { title: "Get shared details", ...READ_ONLY },
    },
    async ({ workspace_id, view_ids }) => {
      if (view_ids !== undefined && view_ids.length === 0) {
        return fail("view_ids was an empty array — pass at least one view id, or omit the parameter for workspace-wide sharing info.");
      }
      return run(() => (view_ids?.length ? client.getSharedDetails(workspace_id, view_ids) : client.getWorkspaceSharedDetails(workspace_id)));
    },
  );

  readTool(
    "zoho_get_my_permissions",
    {
      description: "Get the current user's permissions on a specific view.",
      inputSchema: { workspace_id: ID("Workspace id."), view_id: ID("View id.") },
      annotations: { title: "Get my permissions", ...READ_ONLY },
    },
    async ({ workspace_id, view_id }) => run(() => client.getMyPermissions(workspace_id, view_id)),
  );

  writeTool(
    "zoho_share_views",
    {
      description:
        "Share one or more views with people (and/or groups). `permissions` is a map of booleans — `read` is required true; others include export, vud, addRow, updateRow, deleteRow, drillDown, share. Use options for criteria/invite-mail/column-level controls.",
      inputSchema: {
        workspace_id: ID("Workspace id."),
        view_ids: z.array(z.string()).min(1),
        email_ids: emails,
        permissions: z.record(z.string(), z.boolean()).describe("Permission map; include read:true."),
        group_ids: z.array(z.string()).optional(),
        invite_mail: z.boolean().optional(),
        options: advOpt,
      },
      annotations: { title: "Share views", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ workspace_id, view_ids, email_ids, permissions, group_ids, invite_mail, options }) => {
      audit("share_views", { workspace_id, views: view_ids.length, emails: email_ids.length });
      return run(() =>
        client.shareViews(
          workspace_id,
          adv(
            {
              viewIds: view_ids,
              emailIds: email_ids,
              permissions,
              ...(group_ids ? { groupIds: group_ids } : {}),
              ...(invite_mail != null ? { inviteMail: invite_mail } : {}),
            },
            options,
          ),
        ),
      );
    },
  );

  writeTool(
    "zoho_update_shared_views",
    {
      description:
        "Update the permissions of an existing share on ONE view (the API is per-view) for the given emails/groups. `permissions` is a boolean map.",
      inputSchema: {
        workspace_id: ID("Workspace id."),
        view_id: ID("View whose share permissions to update."),
        email_ids: z.array(z.string()).optional(),
        group_ids: z.array(z.string()).optional(),
        permissions: z.record(z.string(), z.boolean()),
        options: advOpt,
      },
      annotations: { title: "Update shared view", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ workspace_id, view_id, email_ids, group_ids, permissions, options }) => {
      audit("update_shared_views", { workspace_id, view_id, emails: email_ids?.length ?? 0, groups: group_ids?.length ?? 0 });
      return run(() =>
        client.updateSharedViews(
          workspace_id,
          view_id,
          adv({ permissions, ...(email_ids?.length ? { emailIds: email_ids } : {}), ...(group_ids?.length ? { groupIds: group_ids } : {}) }, options),
        ),
      );
    },
  );

  writeTool(
    "zoho_remove_share",
    {
      description: "Revoke sharing for the given emails. Pass view_ids to target specific views, or remove_all_views=true to revoke across the workspace.",
      inputSchema: {
        workspace_id: ID("Workspace id."),
        email_ids: emails,
        view_ids: z.array(z.string()).optional(),
        remove_all_views: z.boolean().optional(),
        group_ids: z.array(z.string()).optional(),
        dry_run: z.boolean().optional(),
      },
      annotations: { title: "Remove share", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ workspace_id, email_ids, view_ids, remove_all_views, group_ids, dry_run }) => {
      // An explicitly-empty list is rejected (not treated as "omitted") so it can
      // never ride alongside removeAllViews as an ambiguous dual-key payload.
      if (view_ids !== undefined && view_ids.length === 0) {
        return fail("view_ids was an empty array — pass view ids, or omit it and set remove_all_views=true.");
      }
      if (!view_ids?.length && !remove_all_views) return fail("Provide view_ids, or remove_all_views=true.");
      if (view_ids?.length && remove_all_views) {
        return fail("Pass either `view_ids` OR remove_all_views=true — not both (ambiguous: all-views would override the list).");
      }
      if (dry_run) return ok({ dry_run: true, action: "remove_share", email_ids, view_ids: view_ids ?? null, remove_all_views: !!remove_all_views, note: "Nothing was changed." });
      audit("remove_share", { workspace_id, emails: email_ids.length });
      return run(() =>
        client.removeShare(workspace_id, {
          emailIds: email_ids,
          ...(view_ids?.length ? { viewIds: view_ids } : {}),
          ...(remove_all_views ? { removeAllViews: true } : {}),
          ...(group_ids?.length ? { groupIds: group_ids } : {}),
        }),
      );
    },
  );

  readTool(
    "zoho_list_groups",
    {
      description: "List the sharing groups in a workspace.",
      inputSchema: { workspace_id: ID("Workspace id.") },
      annotations: { title: "List groups", ...READ_ONLY },
    },
    async ({ workspace_id }) => run(() => client.getGroups(workspace_id)),
  );

  writeTool(
    "zoho_create_group",
    {
      description: "Create a sharing group with initial members.",
      inputSchema: {
        workspace_id: ID("Workspace id."),
        group_name: z.string(),
        email_ids: emails,
        group_desc: z.string().optional(),
        invite_mail: z.boolean().optional(),
      },
      annotations: { title: "Create group", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ workspace_id, group_name, email_ids, group_desc, invite_mail }) =>
      run(() =>
        client.createGroup(workspace_id, {
          groupName: group_name,
          emailIds: email_ids,
          ...(group_desc ? { groupDesc: group_desc } : {}),
          ...(invite_mail != null ? { inviteMail: invite_mail } : {}),
        }),
      ),
  );

  writeTool(
    "zoho_rename_group",
    {
      description: "Rename a sharing group (and optionally change its description).",
      inputSchema: { workspace_id: ID("Workspace id."), group_id: ID("Group id."), group_name: z.string(), group_desc: z.string().optional() },
      annotations: { title: "Rename group", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ workspace_id, group_id, group_name, group_desc }) =>
      run(() => client.renameGroup(workspace_id, group_id, { groupName: group_name, ...(group_desc ? { groupDesc: group_desc } : {}) })),
  );

  writeTool(
    "zoho_delete_group",
    {
      description: "Delete a sharing group.",
      inputSchema: { workspace_id: ID("Workspace id."), group_id: ID("Group id."), dry_run: z.boolean().optional() },
      annotations: { title: "Delete group", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ workspace_id, group_id, dry_run }) => {
      if (dry_run) return ok({ dry_run: true, action: "delete_group", group_id, note: "Nothing was deleted." });
      audit("delete_group", { workspace_id, group_id });
      return run(() => client.deleteGroup(workspace_id, group_id));
    },
  );

  writeTool(
    "zoho_add_group_members",
    {
      description: "Add members to a sharing group.",
      inputSchema: { workspace_id: ID("Workspace id."), group_id: ID("Group id."), email_ids: emails, invite_mail: z.boolean().optional() },
      annotations: { title: "Add group members", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ workspace_id, group_id, email_ids, invite_mail }) =>
      run(() => client.addGroupMembers(workspace_id, group_id, { emailIds: email_ids, ...(invite_mail != null ? { inviteMail: invite_mail } : {}) })),
  );

  writeTool(
    "zoho_remove_group_members",
    {
      description: "Remove members from a sharing group.",
      inputSchema: { workspace_id: ID("Workspace id."), group_id: ID("Group id."), email_ids: emails },
      annotations: { title: "Remove group members", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ workspace_id, group_id, email_ids }) => run(() => client.removeGroupMembers(workspace_id, group_id, { emailIds: email_ids })),
  );

  readTool(
    "zoho_get_workspace_admins",
    {
      description: "List the admins of a workspace.",
      inputSchema: { workspace_id: ID("Workspace id.") },
      annotations: { title: "Get workspace admins", ...READ_ONLY },
    },
    async ({ workspace_id }) => run(() => client.getWorkspaceAdmins(workspace_id)),
  );

  writeTool(
    "zoho_add_workspace_admins",
    {
      description: "Add workspace admins by email.",
      inputSchema: { workspace_id: ID("Workspace id."), email_ids: emails, invite_mail: z.boolean().optional() },
      annotations: { title: "Add workspace admins", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ workspace_id, email_ids, invite_mail }) => {
      audit("add_workspace_admins", { workspace_id, count: email_ids.length });
      return run(() => client.addWorkspaceAdmins(workspace_id, { emailIds: email_ids, ...(invite_mail != null ? { inviteMail: invite_mail } : {}) }));
    },
  );

  writeTool(
    "zoho_remove_workspace_admins",
    {
      description: "Remove workspace admins by email.",
      inputSchema: { workspace_id: ID("Workspace id."), email_ids: emails },
      annotations: { title: "Remove workspace admins", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ workspace_id, email_ids }) => {
      audit("remove_workspace_admins", { workspace_id, count: email_ids.length });
      return run(() => client.removeWorkspaceAdmins(workspace_id, { emailIds: email_ids }));
    },
  );

  readTool(
    "zoho_get_org_admins",
    {
      description: "List the organization admins.",
      inputSchema: {},
      annotations: { title: "Get org admins", ...READ_ONLY },
    },
    async () => run(() => client.getOrgAdmins()),
  );

  // ============================ User management ============================

  readTool(
    "zoho_list_users",
    {
      description: "List the users in the organization (email, status, role).",
      inputSchema: {},
      annotations: { title: "List users", ...READ_ONLY },
    },
    async () => run(() => client.getUsers()),
  );

  readTool(
    "zoho_get_subscription",
    {
      description: "Get the org's subscription/plan details.",
      inputSchema: {},
      annotations: { title: "Get subscription", ...READ_ONLY },
    },
    async () => run(() => client.getSubscription()),
  );

  readTool(
    "zoho_get_resources",
    {
      description: "Get the org's resource usage (allocated / used / remaining).",
      inputSchema: {},
      annotations: { title: "Get resources", ...READ_ONLY },
    },
    async () => run(() => client.getResources()),
  );

  readTool(
    "zoho_list_workspace_users",
    {
      description: "List the users of a specific workspace (email, status, role).",
      inputSchema: { workspace_id: ID("Workspace id.") },
      annotations: { title: "List workspace users", ...READ_ONLY },
    },
    async ({ workspace_id }) => run(() => client.getWorkspaceUsers(workspace_id)),
  );

  writeTool(
    "zoho_add_users",
    {
      description: "Add users to the organization. role is USER (default), VIEWER, or ORGADMIN.",
      inputSchema: { email_ids: emails, role: z.enum(["USER", "VIEWER", "ORGADMIN"]).optional() },
      annotations: { title: "Add users", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ email_ids, role }) => {
      audit("add_users", { count: email_ids.length, role: role ?? "USER" });
      return run(() => client.addUsers({ emailIds: email_ids, ...(role ? { role } : {}) }));
    },
  );

  writeTool(
    "zoho_remove_users",
    {
      description: "Remove users from the organization. Irreversible (re-add to restore access).",
      inputSchema: { email_ids: emails, dry_run: z.boolean().optional() },
      annotations: { title: "Remove users", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ email_ids, dry_run }) => {
      if (dry_run) return ok({ dry_run: true, action: "remove_users", email_ids, note: "Nothing was changed." });
      audit("remove_users", { count: email_ids.length });
      return run(() => client.removeUsers({ emailIds: email_ids }));
    },
  );

  writeTool(
    "zoho_set_users_status",
    {
      description: "Activate or deactivate org users. status='active' or 'inactive'.",
      inputSchema: { email_ids: emails, status: z.enum(["active", "inactive"]).describe("Target status.") },
      annotations: { title: "Set users status", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ email_ids, status }) =>
      run(() => (status === "active" ? client.activateUsers({ emailIds: email_ids }) : client.deactivateUsers({ emailIds: email_ids }))),
  );

  writeTool(
    "zoho_change_user_role",
    {
      description: "Change org users' role: USER, VIEWER, or ORGADMIN.",
      inputSchema: { email_ids: emails, role: z.enum(["USER", "VIEWER", "ORGADMIN"]) },
      annotations: { title: "Change user role", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ email_ids, role }) => {
      audit("change_user_role", { count: email_ids.length, role });
      return run(() => client.changeUserRole({ emailIds: email_ids, role }));
    },
  );

  writeTool(
    "zoho_add_workspace_users",
    {
      description: "Add users to a workspace. role is USER, WORKSPACEADMIN, or a custom role name.",
      inputSchema: { workspace_id: ID("Workspace id."), email_ids: emails, role: z.string().optional() },
      annotations: { title: "Add workspace users", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ workspace_id, email_ids, role }) => {
      audit("add_workspace_users", { workspace_id, count: email_ids.length, role: role ?? "USER" });
      return run(() => client.addWorkspaceUsers(workspace_id, { emailIds: email_ids, ...(role ? { role } : {}) }));
    },
  );

  writeTool(
    "zoho_remove_workspace_users",
    {
      description: "Remove users from a workspace.",
      inputSchema: { workspace_id: ID("Workspace id."), email_ids: emails },
      annotations: { title: "Remove workspace users", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ workspace_id, email_ids }) => run(() => client.deleteWorkspaceUsers(workspace_id, { emailIds: email_ids })),
  );

  writeTool(
    "zoho_change_workspace_user_status",
    {
      description: "Activate or deactivate workspace users. operation='activate' or 'deactivate'.",
      inputSchema: { workspace_id: ID("Workspace id."), email_ids: emails, operation: z.enum(["activate", "deactivate"]) },
      annotations: { title: "Change workspace user status", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ workspace_id, email_ids, operation }) =>
      run(() => client.changeWorkspaceUsersStatus(workspace_id, { emailIds: email_ids, operation })),
  );

  writeTool(
    "zoho_change_workspace_user_role",
    {
      description: "Change workspace users' role: USER, WORKSPACEADMIN, or a custom role name.",
      inputSchema: { workspace_id: ID("Workspace id."), email_ids: emails, role: z.string().describe("USER | WORKSPACEADMIN | <custom role>.") },
      annotations: { title: "Change workspace user role", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ workspace_id, email_ids, role }) => {
      audit("change_workspace_user_role", { workspace_id, count: email_ids.length, role });
      return run(() => client.changeWorkspaceUsersRole(workspace_id, { emailIds: email_ids, role }));
    },
  );

  // ============================ Embed / publish ============================

  readTool(
    "zoho_get_view_url",
    {
      description: "Get a shareable open-view URL for a view. Use options for title/toolbar/legend display flags.",
      inputSchema: { workspace_id: ID("Workspace id."), view_id: ID("View id."), options: advOpt },
      annotations: { title: "Get view URL", readOnlyHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ workspace_id, view_id, options }) => run(() => client.getViewUrl(workspace_id, view_id, options)),
  );

  readTool(
    "zoho_get_embed_url",
    {
      description: "Get an embed URL for a view (embedded-analytics). Use options for validityPeriod/permissions/criteria.",
      inputSchema: { workspace_id: ID("Workspace id."), view_id: ID("View id."), options: advOpt },
      annotations: { title: "Get embed URL", readOnlyHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ workspace_id, view_id, options }) => run(() => client.getEmbedUrl(workspace_id, view_id, options)),
  );

  readTool(
    "zoho_get_private_url",
    {
      description:
        "Get the existing private-link URL for a view (created earlier via zoho_create_private_url, a write tool absent on read-only deploys).",
      inputSchema: { workspace_id: ID("Workspace id."), view_id: ID("View id."), options: advOpt },
      annotations: { title: "Get private URL", ...READ_ONLY },
    },
    async ({ workspace_id, view_id, options }) => run(() => client.getPrivateUrl(workspace_id, view_id, options)),
  );

  writeTool(
    "zoho_create_private_url",
    {
      description: "Create (or regenerate) a private-link URL for a view. Use options for permissions/password/expiryDate.",
      inputSchema: { workspace_id: ID("Workspace id."), view_id: ID("View id."), options: advOpt },
      annotations: { title: "Create private URL", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ workspace_id, view_id, options }) => {
      audit("create_private_url", { workspace_id, view_id });
      return run(() => client.createPrivateUrl(workspace_id, view_id, options));
    },
  );

  writeTool(
    "zoho_remove_private_url",
    {
      description: "Remove the private-link access for a view.",
      inputSchema: { workspace_id: ID("Workspace id."), view_id: ID("View id.") },
      annotations: { title: "Remove private URL", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ workspace_id, view_id }) => run(() => client.removePrivateUrl(workspace_id, view_id)),
  );

  writeTool(
    "zoho_make_view_public",
    {
      description: "Make a view public and return its public URL. Use options for publicPermLevel/permissions/criteria.",
      inputSchema: { workspace_id: ID("Workspace id."), view_id: ID("View id."), options: advOpt },
      annotations: { title: "Make view public", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ workspace_id, view_id, options }) => {
      audit("make_view_public", { workspace_id, view_id });
      return run(() => client.makeViewPublic(workspace_id, view_id, options));
    },
  );

  writeTool(
    "zoho_remove_public",
    {
      description: "Remove public access from a view.",
      inputSchema: { workspace_id: ID("Workspace id."), view_id: ID("View id.") },
      annotations: { title: "Remove public access", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ workspace_id, view_id }) => run(() => client.removePublic(workspace_id, view_id)),
  );

  readTool(
    "zoho_get_publish_config",
    {
      description: "Get a view's publish configuration (public/private/embed settings).",
      inputSchema: { workspace_id: ID("Workspace id."), view_id: ID("View id.") },
      annotations: { title: "Get publish config", ...READ_ONLY },
    },
    async ({ workspace_id, view_id }) => run(() => client.getPublishConfig(workspace_id, view_id)),
  );

  writeTool(
    "zoho_update_publish_config",
    {
      description: "Update a view's publish configuration. Pass the flags to change via options (e.g. includeTitle, includeToolBar, autoRefresh).",
      inputSchema: { workspace_id: ID("Workspace id."), view_id: ID("View id."), options: z.record(z.string(), z.unknown()).describe("Publish config keys to set.") },
      annotations: { title: "Update publish config", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ workspace_id, view_id, options }) => run(() => client.updatePublishConfig(workspace_id, view_id, options)),
  );

  readTool(
    "zoho_list_slideshows",
    {
      description: "List the slideshows in a workspace.",
      inputSchema: { workspace_id: ID("Workspace id.") },
      annotations: { title: "List slideshows", ...READ_ONLY },
    },
    async ({ workspace_id }) => run(() => client.getSlideshows(workspace_id)),
  );

  writeTool(
    "zoho_create_slideshow",
    {
      description: "Create a slideshow from a set of views. access_type: 0=with login, 1=without login, 2=sort.",
      inputSchema: {
        workspace_id: ID("Workspace id."),
        slide_name: z.string(),
        view_ids: z.array(z.string()).min(1),
        access_type: z.number().int().min(0).max(2).optional(),
      },
      annotations: { title: "Create slideshow", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ workspace_id, slide_name, view_ids, access_type }) =>
      run(() => client.createSlideshow(workspace_id, { slideName: slide_name, viewIds: view_ids, ...(access_type != null ? { accessType: access_type } : {}) })),
  );

  readTool(
    "zoho_get_slideshow",
    {
      description: "Get a slideshow's details (name, access type, the view ids it contains) — read before zoho_update_slideshow, which replaces fields blind.",
      inputSchema: { workspace_id: ID("Workspace id."), slide_id: ID("Slideshow id.") },
      annotations: { title: "Get slideshow", ...READ_ONLY },
    },
    async ({ workspace_id, slide_id }) => run(() => client.getSlideshowDetails(workspace_id, slide_id)),
  );

  writeTool(
    "zoho_update_slideshow",
    {
      description: "Update a slideshow's name, views, or access type. Use options for regenerateSlideKey.",
      inputSchema: {
        workspace_id: ID("Workspace id."),
        slide_id: ID("Slideshow id."),
        slide_name: z.string().optional(),
        view_ids: z.array(z.string()).optional(),
        access_type: z.number().int().min(0).max(2).optional(),
        options: advOpt,
      },
      annotations: { title: "Update slideshow", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ workspace_id, slide_id, slide_name, view_ids, access_type, options }) =>
      run(() =>
        client.updateSlideshow(
          workspace_id,
          slide_id,
          adv(
            {
              ...(slide_name ? { slideName: slide_name } : {}),
              ...(view_ids ? { viewIds: view_ids } : {}),
              ...(access_type != null ? { accessType: access_type } : {}),
            },
            options,
          ),
        ),
      ),
  );

  writeTool(
    "zoho_delete_slideshow",
    {
      description: "Delete a slideshow.",
      inputSchema: { workspace_id: ID("Workspace id."), slide_id: ID("Slideshow id.") },
      annotations: { title: "Delete slideshow", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ workspace_id, slide_id }) => run(() => client.deleteSlideshow(workspace_id, slide_id)),
  );

  readTool(
    "zoho_get_slideshow_url",
    {
      description: "Get the shareable URL for a slideshow. Use options for autoplay/slideInterval/title flags.",
      inputSchema: { workspace_id: ID("Workspace id."), slide_id: ID("Slideshow id."), options: advOpt },
      annotations: { title: "Get slideshow URL", readOnlyHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ workspace_id, slide_id, options }) => run(() => client.getSlideshowUrl(workspace_id, slide_id, options)),
  );

  // ============================ Variables ============================

  readTool(
    "zoho_list_variables",
    {
      description: "List the variables defined in a workspace.",
      inputSchema: { workspace_id: ID("Workspace id.") },
      annotations: { title: "List variables", ...READ_ONLY },
    },
    async ({ workspace_id }) => run(() => client.getVariables(workspace_id)),
  );

  writeTool(
    "zoho_create_variable",
    {
      description:
        "Create a variable. variable_type: 0=LIST, 1=RANGE, 3=ALL_VALUES. variable_data_type: 1=PLAIN, 4=NUMBER, 5=POSITIVE_NUMBER, 6=DECIMAL_NUMBER, 7=CURRENCY, 8=PERCENT. Pass defaultData/userSpecificData/format via options.",
      inputSchema: {
        workspace_id: ID("Workspace id."),
        variable_name: z.string(),
        variable_type: z.number().int().describe("0=LIST, 1=RANGE, 3=ALL_VALUES."),
        variable_data_type: z.number().int().describe("1=PLAIN,4=NUMBER,5=POSITIVE_NUMBER,6=DECIMAL_NUMBER,7=CURRENCY,8=PERCENT."),
        options: advOpt,
      },
      annotations: { title: "Create variable", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ workspace_id, variable_name, variable_type, variable_data_type, options }) =>
      run(() =>
        client.createVariable(
          workspace_id,
          adv({ variableName: variable_name, variableType: variable_type, variableDataType: variable_data_type }, options),
        ),
      ),
  );

  readTool(
    "zoho_get_variable",
    {
      description: "Get a variable's full definition (type, data type, default/user-specific values) — read before zoho_update_variable.",
      inputSchema: { workspace_id: ID("Workspace id."), variable_id: ID("Variable id.") },
      annotations: { title: "Get variable", ...READ_ONLY },
    },
    async ({ workspace_id, variable_id }) => run(() => client.getVariableDetails(workspace_id, variable_id)),
  );

  writeTool(
    "zoho_update_variable",
    {
      description: "Update a variable's definition. Pass the fields to change via options (variableName, defaultData, etc.).",
      inputSchema: { workspace_id: ID("Workspace id."), variable_id: ID("Variable id."), options: z.record(z.string(), z.unknown()).describe("Variable fields to set.") },
      annotations: { title: "Update variable", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ workspace_id, variable_id, options }) => run(() => client.updateVariable(workspace_id, variable_id, options)),
  );

  writeTool(
    "zoho_delete_variable",
    {
      description: "Delete a variable.",
      inputSchema: { workspace_id: ID("Workspace id."), variable_id: ID("Variable id.") },
      annotations: { title: "Delete variable", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ workspace_id, variable_id }) => run(() => client.deleteVariable(workspace_id, variable_id)),
  );

  // ============================ Dependents, formulas & import details (reads) ============================

  readTool(
    "zoho_get_dependents",
    {
      description: "List the views that depend on a view — or, when column_id is given, on a specific column. Check before deleting either.",
      inputSchema: { workspace_id: ID("Workspace id."), view_id: ID("View id."), column_id: z.string().optional().describe("Scope to one column.") },
      annotations: { title: "Get dependents", ...READ_ONLY },
    },
    async ({ workspace_id, view_id, column_id }) =>
      run(() => (column_id ? client.getColumnDependents(workspace_id, view_id, column_id) : client.getViewDependents(workspace_id, view_id))),
  );

  readTool(
    "zoho_list_formula_columns",
    {
      description: "List the custom (inline) formula columns of a table.",
      inputSchema: { workspace_id: ID("Workspace id."), view_id: ID("Table id.") },
      annotations: { title: "List formula columns", ...READ_ONLY },
    },
    async ({ workspace_id, view_id }) => run(() => client.getCustomFormulas(workspace_id, view_id)),
  );

  readTool(
    "zoho_list_aggregate_formulas",
    {
      description: "List aggregate formulas — of one table when view_id is given, else across the whole workspace.",
      inputSchema: { workspace_id: ID("Workspace id."), view_id: z.string().optional().describe("Scope to one table.") },
      annotations: { title: "List aggregate formulas", ...READ_ONLY },
    },
    async ({ workspace_id, view_id }) =>
      run(() => (view_id ? client.getViewAggregateFormulas(workspace_id, view_id) : client.getWorkspaceAggregateFormulas(workspace_id))),
  );

  readTool(
    "zoho_get_aggregate_formula_value",
    {
      description: "Evaluate an aggregate formula and return its current value.",
      inputSchema: { workspace_id: ID("Workspace id."), formula_id: ID("Aggregate formula id.") },
      annotations: { title: "Get aggregate formula value", ...READ_ONLY },
    },
    async ({ workspace_id, formula_id }) => run(() => client.getAggregateFormulaValue(workspace_id, formula_id)),
  );

  readTool(
    "zoho_get_aggregate_formula_dependents",
    {
      description: "List the views that depend on an aggregate formula.",
      inputSchema: { workspace_id: ID("Workspace id."), formula_id: ID("Aggregate formula id.") },
      annotations: { title: "Get aggregate formula dependents", ...READ_ONLY },
    },
    async ({ workspace_id, formula_id }) => run(() => client.getAggregateFormulaDependents(workspace_id, formula_id)),
  );

  readTool(
    "zoho_get_last_import_details",
    {
      description: "Get the details of the most recent data import into a table.",
      inputSchema: { workspace_id: ID("Workspace id."), view_id: ID("Table id.") },
      annotations: { title: "Get last import details", ...READ_ONLY },
    },
    async ({ workspace_id, view_id }) => run(() => client.getLastImportDetails(workspace_id, view_id)),
  );

  readTool(
    "zoho_export_workspace_template",
    {
      description:
        "Export selected views as a reusable workspace-template ZIP, returned BASE64-encoded (decode and save as .zip). Useful for cloning a workspace structure.",
      inputSchema: { workspace_id: ID("Workspace id."), view_ids: z.array(z.string()).min(1).describe("Views to include in the template.") },
      annotations: { title: "Export workspace template", ...READ_ONLY },
    },
    async ({ workspace_id, view_ids }) =>
      run(async () => {
        const base64 = await client.exportAsTemplate(workspace_id, view_ids);
        // ~350k base64 chars ≈ 256KB ZIP. Beyond that the payload is useless in an
        // LLM context — refuse with guidance instead of flooding the conversation.
        if (base64.length > 350_000) {
          throw new Error(
            `Template ZIP is ~${Math.round((base64.length * 3) / 4 / 1024)}KB — too large to return inline. Export fewer views per call.`,
          );
        }
        const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
        return { encoding: "base64", media_type: "application/zip", bytes: (base64.length * 3) / 4 - padding, data: base64 };
      }),
  );

  writeTool(
    "zoho_edit_formula_column",
    {
      description: "Update an inline formula column's expression (and optionally its description).",
      inputSchema: {
        workspace_id: ID("Workspace id."),
        view_id: ID("Table id."),
        formula_id: ID("Formula id."),
        expression: z.string().describe("New formula expression."),
        description: z.string().optional(),
      },
      annotations: { title: "Edit formula column", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ workspace_id, view_id, formula_id, expression, description }) =>
      run(() => client.editFormulaColumn(workspace_id, view_id, formula_id, { expression, ...(description ? { description } : {}) })),
  );

  writeTool(
    "zoho_edit_aggregate_formula",
    {
      description: "Update an aggregate formula's expression (and optionally its description).",
      inputSchema: {
        workspace_id: ID("Workspace id."),
        view_id: ID("Table id."),
        formula_id: ID("Formula id."),
        expression: z.string().describe("New aggregate expression."),
        description: z.string().optional(),
      },
      annotations: { title: "Edit aggregate formula", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ workspace_id, view_id, formula_id, expression, description }) =>
      run(() => client.editAggregateFormula(workspace_id, view_id, formula_id, { expression, ...(description ? { description } : {}) })),
  );

  writeTool(
    "zoho_copy_formulas",
    {
      description:
        "Copy formula columns from a table to a matching table (same name + columns) in ANOTHER workspace/org. dest_org_id required; pass workspace_key for cross-org.",
      inputSchema: {
        workspace_id: ID("Source workspace id."),
        view_id: ID("Source table id."),
        formula_column_names: z.array(z.string()).min(1).describe("Formula column names to copy."),
        dest_workspace_id: ID("Destination workspace id."),
        dest_org_id: ID("Destination org id."),
        workspace_key: z.string().optional().describe("Source workspace secret key (cross-org)."),
      },
      annotations: { title: "Copy formulas", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ workspace_id, view_id, formula_column_names, dest_workspace_id, dest_org_id, workspace_key }) =>
      run(() =>
        client.copyFormulas(
          workspace_id,
          view_id,
          { formulaColumnNames: formula_column_names, destWorkspaceId: dest_workspace_id, ...(workspace_key ? { workspaceKey: workspace_key } : {}) },
          dest_org_id,
        ),
      ),
  );

  writeTool(
    "zoho_create_similar_views",
    {
      description: "Create views similar to a reference view, based over another table (e.g. replicate a report over a new table).",
      inputSchema: {
        workspace_id: ID("Workspace id."),
        view_id: ID("Base table id for the new views."),
        reference_view_id: ID("View to replicate."),
        folder_id: ID("Folder to place the new views in."),
        copy_custom_formula: z.boolean().optional(),
        copy_agg_formula: z.boolean().optional(),
      },
      annotations: { title: "Create similar views", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ workspace_id, view_id, reference_view_id, folder_id, copy_custom_formula, copy_agg_formula }) =>
      run(() =>
        client.createSimilarViews(workspace_id, view_id, {
          referenceViewId: reference_view_id,
          folderId: folder_id,
          ...(copy_custom_formula != null ? { copyCustomFormula: copy_custom_formula } : {}),
          ...(copy_agg_formula != null ? { copyAggFormula: copy_agg_formula } : {}),
        }),
      ),
  );

  writeTool(
    "zoho_auto_analyse",
    {
      description: "Auto-generate reports for a table — or, when column_id is given, for one column (Zoho's auto-analysis).",
      inputSchema: { workspace_id: ID("Workspace id."), view_id: ID("Table id."), column_id: z.string().optional().describe("Analyse just this column.") },
      annotations: { title: "Auto analyse", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ workspace_id, view_id, column_id }) =>
      run(() => (column_id ? client.autoAnalyseColumn(workspace_id, view_id, column_id) : client.autoAnalyseView(workspace_id, view_id))),
  );

  // ============================ Folder placement ============================

  writeTool(
    "zoho_make_default_folder",
    {
      description: "Make a folder the workspace's default folder (where new views land).",
      inputSchema: { workspace_id: ID("Workspace id."), folder_id: ID("Folder id.") },
      annotations: { title: "Make default folder", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ workspace_id, folder_id }) => run(() => client.makeDefaultFolder(workspace_id, folder_id)),
  );

  writeTool(
    "zoho_move_folder",
    {
      description: "Change a folder's hierarchy: hierarchy 0 = make it a top-level (parent) folder, 1 = make it a child of parent_folder_id.",
      inputSchema: {
        workspace_id: ID("Workspace id."),
        folder_id: ID("Folder id."),
        hierarchy: z.number().int().min(0).max(1).describe("0 = parent (top-level), 1 = child."),
        parent_folder_id: z.string().optional().describe("Required when hierarchy=1."),
      },
      annotations: { title: "Move folder", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ workspace_id, folder_id, hierarchy, parent_folder_id }) => {
      if (hierarchy === 1 && !parent_folder_id) return fail("parent_folder_id is required when hierarchy=1 (move as child).");
      return run(() => client.moveFolder(workspace_id, folder_id, { hierarchy, ...(parent_folder_id ? { parentFolderId: parent_folder_id } : {}) }));
    },
  );

  writeTool(
    "zoho_reorder_folder",
    {
      description: "Reposition a folder relative to another folder (placed after the reference folder).",
      inputSchema: { workspace_id: ID("Workspace id."), folder_id: ID("Folder id."), reference_folder_id: ID("Folder used as the position reference.") },
      annotations: { title: "Reorder folder", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ workspace_id, folder_id, reference_folder_id }) =>
      run(() => client.reorderFolder(workspace_id, folder_id, { referenceFolderId: reference_folder_id })),
  );

  // ============================ Favorites, default workspace & domain access ============================

  writeTool(
    "zoho_set_favorite_workspace",
    {
      description: "Mark or unmark a workspace as a favorite.",
      inputSchema: { workspace_id: ID("Workspace id."), favorite: z.boolean().describe("true = add favorite, false = remove.") },
      annotations: { title: "Set favorite workspace", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ workspace_id, favorite }) => run(() => client.setFavoriteWorkspace(workspace_id, favorite)),
  );

  writeTool(
    "zoho_set_favorite_view",
    {
      description: "Mark or unmark a view as a favorite.",
      inputSchema: { workspace_id: ID("Workspace id."), view_id: ID("View id."), favorite: z.boolean().describe("true = add favorite, false = remove.") },
      annotations: { title: "Set favorite view", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ workspace_id, view_id, favorite }) => run(() => client.setFavoriteView(workspace_id, view_id, favorite)),
  );

  writeTool(
    "zoho_set_default_workspace",
    {
      description: "Set or unset a workspace as your default workspace.",
      inputSchema: { workspace_id: ID("Workspace id."), is_default: z.boolean().describe("true = make default, false = remove default.") },
      annotations: { title: "Set default workspace", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ workspace_id, is_default }) => run(() => client.setDefaultWorkspace(workspace_id, is_default)),
  );

  writeTool(
    "zoho_set_workspace_domain_access",
    {
      description: "Enable or disable white-label (custom domain) access for a workspace.",
      inputSchema: { workspace_id: ID("Workspace id."), enabled: z.boolean() },
      annotations: { title: "Set workspace domain access", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ workspace_id, enabled }) => {
      audit("set_workspace_domain_access", { workspace_id, enabled });
      return run(() => client.setWorkspaceDomainAccess(workspace_id, enabled));
    },
  );

  // ============================ Data sources & sync ============================

  writeTool(
    "zoho_sync_datasource",
    {
      description:
        "Trigger an on-demand data sync for a datasource (get datasource ids from zoho_list_datasources).",
      inputSchema: { workspace_id: ID("Workspace id."), datasource_id: ID("Datasource id.") },
      annotations: { title: "Sync datasource", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ workspace_id, datasource_id }) => run(() => client.syncDatasource(workspace_id, datasource_id)),
  );

  writeTool(
    "zoho_update_datasource_connection",
    {
      description: "Update a datasource's connection configuration (the config object is connector-specific; see Zoho's datasource docs).",
      inputSchema: {
        workspace_id: ID("Workspace id."),
        datasource_id: ID("Datasource id."),
        connection_config: z.record(z.string(), z.unknown()).describe("Connector-specific connection settings."),
      },
      annotations: { title: "Update datasource connection", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ workspace_id, datasource_id, connection_config }) => {
      audit("update_datasource_connection", { workspace_id, datasource_id, fields: Object.keys(connection_config) });
      return run(() => client.updateDatasourceConnection(workspace_id, datasource_id, connection_config));
    },
  );

  writeTool(
    "zoho_refetch_view_data",
    {
      description: "Re-fetch a view's data from its original source (re-sync one view).",
      inputSchema: { workspace_id: ID("Workspace id."), view_id: ID("View id.") },
      annotations: { title: "Refetch view data", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ workspace_id, view_id }) => run(() => client.refetchViewData(workspace_id, view_id)),
  );

  // ============================ Email schedules ============================

  readTool(
    "zoho_list_email_schedules",
    {
      description: "List the scheduled email exports configured in a workspace.",
      inputSchema: { workspace_id: ID("Workspace id.") },
      annotations: { title: "List email schedules", ...READ_ONLY },
    },
    async ({ workspace_id }) => run(() => client.getEmailSchedules(workspace_id)),
  );

  writeTool(
    "zoho_create_email_schedule",
    {
      description:
        "Create a scheduled email export of views. schedule_details: { calendarFrequency: daily|weekly|monthly|yearly, hour (0-23), minute (0,5,...,55), weekDays?/monthDays?/months? }. export_type: csv|xls|img|pdf|html. Sends recurring real emails once active.",
      inputSchema: {
        workspace_id: ID("Workspace id."),
        schedule_name: z.string(),
        view_ids: z.array(z.string()).min(1).describe("Views to include in the emailed export."),
        export_type: z.enum(["csv", "xls", "img", "pdf", "html"]),
        schedule_details: z.record(z.string(), z.unknown()).describe("{ calendarFrequency, hour, minute, ... }."),
        email_ids: z.array(z.string()).optional().describe("Recipients."),
        subject: z.string().optional(),
        message: z.string().optional(),
        options: advOpt,
      },
      annotations: { title: "Create email schedule", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ workspace_id, schedule_name, view_ids, export_type, schedule_details, email_ids, subject, message, options }) => {
      audit("create_email_schedule", { workspace_id, schedule_name, views: view_ids.length });
      return run(() =>
        client.createEmailSchedule(
          workspace_id,
          adv(
            {
              scheduleName: schedule_name,
              viewIds: view_ids,
              exportType: export_type,
              scheduleDetails: schedule_details,
              ...(email_ids ? { emailIds: email_ids } : {}),
              ...(subject ? { subject } : {}),
              ...(message ? { message } : {}),
            },
            options,
          ),
        ),
      );
    },
  );

  writeTool(
    "zoho_update_email_schedule",
    {
      description: "Update an email schedule. Pass the fields to change via options (scheduleName, viewIds, exportType, scheduleDetails, emailIds, ...).",
      inputSchema: {
        workspace_id: ID("Workspace id."),
        schedule_id: ID("Schedule id."),
        options: z.record(z.string(), z.unknown()).describe("Schedule fields to set."),
      },
      annotations: { title: "Update email schedule", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ workspace_id, schedule_id, options }) => {
      audit("update_email_schedule", { workspace_id, schedule_id, fields: Object.keys(options) });
      return run(() => client.updateEmailSchedule(workspace_id, schedule_id, options));
    },
  );

  writeTool(
    "zoho_delete_email_schedule",
    {
      description: "Delete an email schedule.",
      inputSchema: { workspace_id: ID("Workspace id."), schedule_id: ID("Schedule id."), dry_run: z.boolean().optional() },
      annotations: { title: "Delete email schedule", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ workspace_id, schedule_id, dry_run }) => {
      if (dry_run) return ok({ dry_run: true, action: "delete_email_schedule", schedule_id, note: "Nothing was deleted." });
      audit("delete_email_schedule", { workspace_id, schedule_id });
      return run(() => client.deleteEmailSchedule(workspace_id, schedule_id));
    },
  );

  writeTool(
    "zoho_trigger_email_schedule",
    {
      description: "Send a scheduled email NOW (out of schedule). Sends real email each call — dry_run previews.",
      inputSchema: { workspace_id: ID("Workspace id."), schedule_id: ID("Schedule id."), dry_run: z.boolean().optional() },
      annotations: { title: "Trigger email schedule", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ workspace_id, schedule_id, dry_run }) => {
      if (dry_run) return ok({ dry_run: true, action: "trigger_email_schedule", schedule_id, note: "Would send the scheduled email now. Nothing was sent." });
      audit("trigger_email_schedule", { workspace_id, schedule_id });
      return run(() => client.triggerEmailSchedule(workspace_id, schedule_id));
    },
  );

  writeTool(
    "zoho_set_email_schedule_status",
    {
      description: "Activate or deactivate an email schedule.",
      inputSchema: {
        workspace_id: ID("Workspace id."),
        schedule_id: ID("Schedule id."),
        operation: z.enum(["activate", "deactivate"]),
      },
      annotations: { title: "Set email schedule status", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ workspace_id, schedule_id, operation }) => {
      audit("set_email_schedule_status", { workspace_id, schedule_id, operation });
      return run(() => client.changeEmailScheduleStatus(workspace_id, schedule_id, { operation }));
    },
  );

  // ============================ AutoML ============================

  readTool(
    "zoho_list_automl_analysis",
    {
      description: "List AutoML analyses — across the org, or within one workspace when workspace_id is given.",
      inputSchema: { workspace_id: z.string().optional().describe("Scope to one workspace.") },
      annotations: { title: "List AutoML analyses", ...READ_ONLY },
    },
    async ({ workspace_id }) =>
      run(() => (workspace_id ? client.getAutoMLAnalysisInWorkspace(workspace_id) : client.getAutoMLAnalysisOrg())),
  );

  readTool(
    "zoho_get_automl_analysis",
    {
      description: "Get the details of an AutoML analysis (models, status, metrics).",
      inputSchema: { workspace_id: ID("Workspace id."), analysis_id: ID("Analysis id.") },
      annotations: { title: "Get AutoML analysis", ...READ_ONLY },
    },
    async ({ workspace_id, analysis_id }) => run(() => client.getAutoMLAnalysisDetails(workspace_id, analysis_id)),
  );

  readTool(
    "zoho_list_automl_deployments",
    {
      description: "List the deployments of an AutoML model.",
      inputSchema: { workspace_id: ID("Workspace id."), analysis_id: ID("Analysis id."), model_id: ID("Model id.") },
      annotations: { title: "List AutoML deployments", ...READ_ONLY },
    },
    async ({ workspace_id, analysis_id, model_id }) => run(() => client.getAutoMLModelDeployments(workspace_id, analysis_id, model_id)),
  );

  writeTool(
    "zoho_create_automl_analysis",
    {
      description:
        "Create an AutoML analysis (trains models). prediction_type: REGRESSION | CLASSIFICATION | CLUSTERING. features = input column names; algorithms is the per-algorithm tuning object (see Zoho AutoML docs); server_option 1-3 picks server memory.",
      inputSchema: {
        workspace_id: ID("Workspace id."),
        name: z.string().describe("Analysis name."),
        training_table_id: z.string().describe("Id of the training table."),
        prediction_type: z.enum(["REGRESSION", "CLASSIFICATION", "CLUSTERING"]),
        features: z.array(z.string()).min(1).describe("Input feature column names."),
        algorithms: z.record(z.string(), z.unknown()).describe("Algorithm configuration object (e.g. { randomForestRegression: {...} })."),
        server_option: z.number().int().min(1).max(3).describe("Server memory option (1-3)."),
        target_column: z.string().optional().describe("Column to predict (required for regression/classification)."),
        description: z.string().optional(),
      },
      annotations: { title: "Create AutoML analysis", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ workspace_id, name, training_table_id, prediction_type, features, algorithms, server_option, target_column, description }) => {
      audit("create_automl_analysis", { workspace_id, name, prediction_type });
      return run(() =>
        client.createAutoMLAnalysis(workspace_id, {
          name,
            // Sent as the original string: Zoho ids are 18-19 digits, which exceed
          // Number.MAX_SAFE_INTEGER and would silently corrupt via Number().
          trainingTableId: training_table_id,
          predictionType: prediction_type,
          features,
          algorithms,
          serverOption: server_option,
          ...(target_column ? { targetColumn: target_column } : {}),
          ...(description ? { description } : {}),
        }),
      );
    },
  );

  writeTool(
    "zoho_delete_automl_analysis",
    {
      description: "Delete an AutoML analysis (and its models). Irreversible.",
      inputSchema: { workspace_id: ID("Workspace id."), analysis_id: ID("Analysis id."), dry_run: z.boolean().optional() },
      annotations: { title: "Delete AutoML analysis", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ workspace_id, analysis_id, dry_run }) => {
      if (dry_run) return ok({ dry_run: true, action: "delete_automl_analysis", analysis_id, note: "Nothing was deleted." });
      audit("delete_automl_analysis", { workspace_id, analysis_id });
      return run(() => client.deleteAutoMLAnalysis(workspace_id, analysis_id));
    },
  );

  writeTool(
    "zoho_delete_automl_model",
    {
      description: "Delete one model from an AutoML analysis. Irreversible.",
      inputSchema: { workspace_id: ID("Workspace id."), analysis_id: ID("Analysis id."), model_id: ID("Model id."), dry_run: z.boolean().optional() },
      annotations: { title: "Delete AutoML model", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ workspace_id, analysis_id, model_id, dry_run }) => {
      if (dry_run) return ok({ dry_run: true, action: "delete_automl_model", model_id, note: "Nothing was deleted." });
      audit("delete_automl_model", { workspace_id, analysis_id, model_id });
      return run(() => client.deleteAutoMLModel(workspace_id, analysis_id, model_id));
    },
  );

  writeTool(
    "zoho_create_automl_deployment",
    {
      description:
        "Deploy an AutoML model: reads input_table, writes predictions to output_table on a schedule. schedule_details: { calendarFrequency: none|hourly|daily|weekly|monthly, hour?, minute?, ... }. import_type: APPEND | TRUNCATEADD | UPDATEADD (UPDATEADD needs matching_columns).",
      inputSchema: {
        workspace_id: ID("Workspace id."),
        analysis_id: ID("Analysis id."),
        model_id: ID("Model id."),
        input_table_id: z.string().describe("Table to read input rows from."),
        output_table: z.string().describe("Table name to write predictions to."),
        prediction_column: z.string().describe("Column name for the predictions."),
        output_columns: z.array(z.string()).min(1).describe("Columns to carry into the output table."),
        schedule_details: z.record(z.string(), z.unknown()).describe("{ calendarFrequency, hour?, minute?, ... }."),
        import_type: z.enum(["APPEND", "TRUNCATEADD", "UPDATEADD"]),
        server_option: z.number().int().min(1).max(3),
        matching_columns: z.array(z.string()).optional().describe("Required when import_type=UPDATEADD."),
        timezone: z.string().optional(),
      },
      annotations: { title: "Create AutoML deployment", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (a) => {
      if (a.import_type === "UPDATEADD" && !a.matching_columns?.length) {
        return fail("matching_columns is required when import_type=UPDATEADD.");
      }
      audit("create_automl_deployment", { workspace_id: a.workspace_id, analysis_id: a.analysis_id, model_id: a.model_id });
      return run(() =>
        client.createAutoMLDeployment(a.workspace_id, a.analysis_id, a.model_id, {
          // String, not Number(): 18-19 digit ids exceed MAX_SAFE_INTEGER.
          inputTableId: a.input_table_id,
          outputTable: a.output_table,
          predictionColumn: a.prediction_column,
          outputColumns: a.output_columns,
          scheduleDetails: a.schedule_details,
          importType: a.import_type,
          serverOption: a.server_option,
          ...(a.matching_columns ? { matchingColumns: a.matching_columns } : {}),
          ...(a.timezone ? { timezone: a.timezone } : {}),
        }),
      );
    },
  );

  writeTool(
    "zoho_delete_automl_deployment",
    {
      description: "Delete an AutoML model deployment. Irreversible.",
      inputSchema: { workspace_id: ID("Workspace id."), analysis_id: ID("Analysis id."), deployment_id: ID("Deployment id."), dry_run: z.boolean().optional() },
      annotations: { title: "Delete AutoML deployment", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ workspace_id, analysis_id, deployment_id, dry_run }) => {
      if (dry_run) return ok({ dry_run: true, action: "delete_automl_deployment", deployment_id, note: "Nothing was deleted." });
      audit("delete_automl_deployment", { workspace_id, analysis_id, deployment_id });
      return run(() => client.deleteAutoMLDeployment(workspace_id, analysis_id, deployment_id));
    },
  );

  writeTool(
    "zoho_run_automl_deployment",
    {
      description: "Run an AutoML deployment NOW (out of schedule) — generates predictions into the output table.",
      inputSchema: { workspace_id: ID("Workspace id."), analysis_id: ID("Analysis id."), deployment_id: ID("Deployment id.") },
      annotations: { title: "Run AutoML deployment", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ workspace_id, analysis_id, deployment_id }) => {
      audit("run_automl_deployment", { workspace_id, analysis_id, deployment_id });
      return run(() => client.runAutoMLDeployment(workspace_id, analysis_id, deployment_id));
    },
  );

  readTool(
    "zoho_automl_whatif",
    {
      description: "What-if analysis: feed a model one set of feature values and get its prediction. features = { columnName: value, ... }.",
      inputSchema: {
        workspace_id: ID("Workspace id."),
        analysis_id: ID("Analysis id."),
        model_id: ID("Model id."),
        features: z.record(z.string(), cellValue).describe("Feature inputs, e.g. { \"Age\": 42, \"Region\": \"East\" }."),
      },
      annotations: { title: "AutoML what-if", readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ workspace_id, analysis_id, model_id, features }) =>
      run(() => client.autoMLWhatIf(workspace_id, analysis_id, model_id, { features })),
  );
}

/**
 * MCP resources + prompts (shared by both workers).
 *
 * Resources let a consumer browse context without burning tool calls; prompts
 * encode the proven everyday workflows so a smaller model (the intended daily
 * consumer is Sonnet-class) starts from a good plan instead of rediscovering one.
 */
export function registerResourcesAndPrompts(server: McpServer, client: ZohoAnalyticsClient): void {
  server.registerResource(
    "workspaces",
    "zoho://workspaces",
    {
      title: "Zoho Analytics workspaces",
      description: "All workspaces (owned + shared) visible to this connector, as compact JSON.",
      mimeType: "application/json",
    },
    async (uri) => {
      const res = (await client.getWorkspaces()) as AnyRec;
      const data = res?.data ?? res;
      const trim = (ws: AnyRec[] | undefined) =>
        (ws ?? []).map((w) => ({ workspaceId: w.workspaceId, workspaceName: w.workspaceName }));
      const body = { ownedWorkspaces: trim(data?.ownedWorkspaces), sharedWorkspaces: trim(data?.sharedWorkspaces) };
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(body, null, 2) }] };
    },
  );

  server.registerPrompt(
    "profile-workspace",
    {
      title: "Profile a workspace",
      description: "Map a workspace's tables and columns, then sample its key data.",
      argsSchema: { workspace: z.string().optional().describe("Workspace name or id (omit to pick interactively).") },
    },
    ({ workspace }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Profile my Zoho Analytics workspace${workspace ? ` "${workspace}"` : ""}. ` +
              `Steps: (1) zoho_list_workspaces to resolve the workspace id${workspace ? "" : " and ask me which one"}; ` +
              `(2) zoho_describe_workspace for the schema map (tables + columns); ` +
              `(3) for the 2-3 most important tables, run zoho_query_data with COUNT(*) and a 5-row sample ` +
              `(remember: quote identifiers, alias aggregates and order by the alias); ` +
              `(4) summarize what this workspace tracks, table by table, with row counts.`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "analytics-question",
    {
      title: "Answer a data question with SQL",
      description: "Translate a business question into Zoho SQL and answer it with real data.",
      argsSchema: {
        question: z.string().describe("The business question, e.g. 'top 5 users by activity this month'."),
        workspace: z.string().optional().describe("Workspace name or id, if known."),
      },
    },
    ({ question, workspace }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Answer this question from my Zoho Analytics data: "${question}". ` +
              `${workspace ? `Use workspace "${workspace}". ` : "First resolve the right workspace via zoho_list_workspaces. "}` +
              `Find the relevant table with zoho_describe_workspace, then answer with zoho_query_data. ` +
              `Zoho SQL rules: double-quote all identifiers; never put aggregates in ORDER BY/GROUP BY/WHERE — ` +
              `alias them in SELECT and reference the alias; non-aggregated SELECT columns must appear in GROUP BY. ` +
              `Show the SQL you ran and present the result as a small table with a one-line takeaway.`,
          },
        },
      ],
    }),
  );
}
