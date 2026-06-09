/**
 * Zoho Analytics REST API (v2) client.
 *
 * Dependency-free: uses only the global `fetch`, so this exact file also runs
 * unmodified inside a Cloudflare Worker.
 *
 * Auth is OAuth 2.0. Access tokens expire hourly, so this client holds a
 * refresh token + client id/secret and mints/caches access tokens itself,
 * sending them as `Authorization: Zoho-oauthtoken <access_token>`. The org is
 * identified by the `ZANALYTICS-ORGID` header.
 *
 * Request convention: most operation options travel in a `CONFIG` value that is
 * a JSON object. For GET (and multipart import) it rides in the query string;
 * for POST/PUT/DELETE it is sent as an `application/x-www-form-urlencoded` body
 * (`CONFIG=<url-encoded-json>`), matching Zoho's documented `--data-urlencode`.
 * Responses use the `{status, summary, data}` envelope; many mutations return
 * HTTP 204 with no body (surfaced here as `{status:"success"}`); the export and
 * download endpoints stream raw file bytes.
 *
 * Docs: https://www.zoho.com/analytics/api/v2/introduction.html
 * Specs: https://github.com/zoho/analytics-oas
 */

/** Per-data-center API + accounts (OAuth) domains. */
export const DC_DOMAINS: Record<string, { api: string; accounts: string }> = {
  com: { api: "analyticsapi.zoho.com", accounts: "accounts.zoho.com" },
  eu: { api: "analyticsapi.zoho.eu", accounts: "accounts.zoho.eu" },
  in: { api: "analyticsapi.zoho.in", accounts: "accounts.zoho.in" },
  au: { api: "analyticsapi.zoho.com.au", accounts: "accounts.zoho.com.au" },
  jp: { api: "analyticsapi.zoho.jp", accounts: "accounts.zoho.jp" },
  sa: { api: "analyticsapi.zoho.sa", accounts: "accounts.zoho.sa" },
  ca: { api: "analyticsapi.zohocloud.ca", accounts: "accounts.zohocloud.ca" },
  uk: { api: "analyticsapi.zoho.uk", accounts: "accounts.zoho.uk" },
};

/** Zoho Analytics view-type codes -> human-readable. */
export const VIEW_TYPE_NAMES: Record<string, string> = {
  "0": "Table",
  "1": "Tabular View",
  "2": "Chart",
  "3": "Pivot",
  "4": "Summary",
  "6": "Query Table",
  "7": "Dashboard",
};

/** Bulk job status codes (jobCode) returned while polling import/export jobs. */
export const JOB_CODE = {
  IN_PROGRESS_A: "1001",
  IN_PROGRESS_B: "1002",
  COMPLETED: "1004",
  INVALID: "1005",
} as const;

export class ZohoAnalyticsError extends Error {
  constructor(
    public status: number,
    public errorCode: number | null,
    public body: string,
    public method: string,
    public path: string,
  ) {
    super(
      `Zoho Analytics API ${method} ${path} -> ${status}` +
        (errorCode != null ? ` (errorCode ${errorCode})` : "") +
        `: ${body}`,
    );
    this.name = "ZohoAnalyticsError";
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Run an async fn over `items` with bounded concurrency, preserving input order.
 * Used by batch tools (e.g. describe-workspace) so we never open hundreds of
 * simultaneous connections or trip Zoho's per-minute frequency limiter.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Math.max(1, Math.min(limit, items.length || 1));
  await Promise.all(
    Array.from({ length: workers }, async () => {
      for (;;) {
        const i = cursor++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

export type ResponseFormat = "json" | "csv" | "xml" | "xls" | "pdf" | "html";
export type ImportType = "append" | "truncateadd" | "updateadd";
type Config = Record<string, unknown>;

export interface ZohoAnalyticsClientOptions {
  /** OAuth client id (from the registered Zoho API client). */
  clientId?: string;
  /** OAuth client secret (may be per-DC). */
  clientSecret?: string;
  /** Long-lived refresh token (access_type=offline). */
  refreshToken?: string;
  /**
   * A pre-minted access token. Expires in ~1h and is never refreshed, so this
   * is mainly for quick testing. Prefer the refresh-token path above.
   */
  accessToken?: string;
  /** ZANALYTICS-ORGID sent on workspace/view/data calls. */
  orgId?: string;
  /** Data-center key: com | eu | in | au | jp | sa | ca | uk. Default "com". */
  dc?: string;
  /** Override the API root, e.g. "https://analyticsapi.zoho.com". */
  analyticsBaseUrl?: string;
  /** Override the accounts/OAuth origin, e.g. "https://accounts.zoho.com". */
  accountsBaseUrl?: string;
  /** Max retry attempts for transient failures on idempotent (GET) calls. Default 3. */
  maxRetries?: number;
  /** Per-request timeout in ms. Default 30000. */
  timeoutMs?: number;
  /** Base for exponential backoff (ms). Default 1000. Lower it in tests for speed. */
  backoffBaseMs?: number;
}

interface CoreOptions {
  /** Object serialized into the CONFIG parameter (query for GET/multipart, form body otherwise). */
  config?: unknown;
  /** Raw JSON request body (the few endpoints that take application/json, e.g. sort). */
  jsonBody?: unknown;
  /** Multipart form (bulk import). When present, CONFIG rides in the query string. */
  form?: FormData;
  /** Extra request headers (e.g. ZANALYTICS-DEST-ORGID for cross-org copies). */
  headers?: Record<string, string>;
}

export class ZohoAnalyticsClient {
  private clientId?: string;
  private clientSecret?: string;
  private refreshToken?: string;
  private staticAccessToken?: string;
  private orgId?: string;
  private apiRoot: string;
  private accountsOrigin: string;
  private maxRetries: number;
  private timeoutMs: number;
  private backoffBaseMs: number;

  // Cached access token + absolute expiry (epoch ms).
  private accessToken?: string;
  private accessTokenExpiry = 0;

  constructor(opts: ZohoAnalyticsClientOptions) {
    const hasRefresh = !!(opts.refreshToken && opts.clientId && opts.clientSecret);
    if (!hasRefresh && !opts.accessToken) {
      throw new Error(
        "ZohoAnalyticsClient needs either {refreshToken, clientId, clientSecret} or a static accessToken.",
      );
    }
    this.clientId = opts.clientId;
    this.clientSecret = opts.clientSecret;
    this.refreshToken = opts.refreshToken;
    this.staticAccessToken = opts.accessToken;
    this.orgId = opts.orgId;

    const dc = (opts.dc ?? "com").toLowerCase();
    const domains = DC_DOMAINS[dc];
    if (!domains && !(opts.analyticsBaseUrl && opts.accountsBaseUrl)) {
      throw new Error(
        `Unknown data center "${dc}". Use one of: ${Object.keys(DC_DOMAINS).join(", ")} — or set analyticsBaseUrl + accountsBaseUrl explicitly.`,
      );
    }
    const apiOrigin = (opts.analyticsBaseUrl ?? `https://${domains.api}`).replace(/\/+$/, "");
    // Allow either a bare origin or one that already includes /restapi/v2.
    this.apiRoot = /\/restapi\/v2$/.test(apiOrigin) ? apiOrigin : `${apiOrigin}/restapi/v2`;
    this.accountsOrigin = (opts.accountsBaseUrl ?? `https://${domains.accounts}`).replace(/\/+$/, "");

    this.maxRetries = opts.maxRetries ?? 3;
    this.timeoutMs = opts.timeoutMs ?? 30000;
    this.backoffBaseMs = opts.backoffBaseMs ?? 1000;
  }

  // ---- OAuth token management ----

  /** Return a valid access token, refreshing it if absent/expired (60s skew buffer). */
  private async getAccessToken(): Promise<string> {
    if (this.staticAccessToken) return this.staticAccessToken;
    if (this.accessToken && Date.now() < this.accessTokenExpiry - 60_000) {
      return this.accessToken;
    }
    return this.refreshAccessToken();
  }

  /** Exchange the refresh token for a fresh access token at the accounts endpoint. */
  private async refreshAccessToken(): Promise<string> {
    if (!this.refreshToken || !this.clientId || !this.clientSecret) {
      throw new Error("Cannot refresh: missing refreshToken/clientId/clientSecret.");
    }
    const params = new URLSearchParams({
      refresh_token: this.refreshToken,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      grant_type: "refresh_token",
    });
    const url = `${this.accountsOrigin}/oauth/v2/token?${params.toString()}`;

    let lastErr = "";
    for (let attempt = 0; attempt <= 2; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await fetch(url, { method: "POST", signal: controller.signal });
        clearTimeout(timer);
        const text = await res.text();
        let data: Record<string, unknown> = {};
        try {
          data = text ? JSON.parse(text) : {};
        } catch {
          /* non-JSON body handled below */
        }
        if (res.ok && typeof data.access_token === "string") {
          this.accessToken = data.access_token;
          const expiresIn = typeof data.expires_in === "number" ? data.expires_in : 3600;
          this.accessTokenExpiry = Date.now() + expiresIn * 1000;
          return this.accessToken;
        }
        // Zoho reports OAuth failures as { error: "invalid_code" } with HTTP 200.
        const errCode = typeof data.error === "string" ? data.error : `HTTP ${res.status}`;
        lastErr = `${errCode}${text && !data.error ? `: ${text}` : ""}`;
        if (res.status < 500) break; // client error -> don't retry
      } catch (err) {
        clearTimeout(timer);
        lastErr = err instanceof Error ? err.message : String(err);
      }
      if (attempt < 2) await sleep(this.backoffBaseMs * (attempt + 1));
    }
    throw new Error(`Zoho OAuth token refresh failed: ${lastErr}`);
  }

  // ---- Core request plumbing ----

  private buildUrl(path: string, config?: unknown): string {
    let url = `${this.apiRoot}${path}`;
    if (config !== undefined) {
      const params = new URLSearchParams();
      params.set("CONFIG", JSON.stringify(config));
      url += `${url.includes("?") ? "&" : "?"}${params.toString()}`;
    }
    return url;
  }

  /** Exponential backoff with jitter; honors Retry-After (seconds) when present. */
  private backoff(attempt: number, retryAfter: string | null): Promise<void> {
    let delayMs: number;
    const secs = retryAfter ? Number(retryAfter) : NaN;
    if (Number.isFinite(secs)) {
      delayMs = secs * 1000;
    } else {
      delayMs = Math.min(this.backoffBaseMs * 2 ** attempt, 8000);
    }
    delayMs += Math.floor(Math.random() * 250); // jitter
    return new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  /**
   * Fetch with auth-token injection, one transparent refresh-and-retry on 401,
   * and bounded transient retry for idempotent (GET) calls. Returns the final
   * Response plus its body text; callers decide how to interpret it.
   */
  private async core(
    method: string,
    path: string,
    opts: CoreOptions = {},
  ): Promise<{ res: Response; text: string }> {
    // CONFIG placement: query string for GET and for multipart (import); form body otherwise.
    const configInQuery = !!opts.form || method === "GET";
    const url = this.buildUrl(path, opts.config !== undefined && configInQuery ? opts.config : undefined);
    const isIdempotent = method === "GET";

    let body: BodyInit | undefined;
    let contentType: string | undefined;
    if (opts.form) {
      body = opts.form; // multipart; let fetch set the boundary
    } else if (opts.jsonBody !== undefined) {
      body = JSON.stringify(opts.jsonBody);
      contentType = "application/json";
    } else if (opts.config !== undefined && !configInQuery) {
      body = `CONFIG=${encodeURIComponent(JSON.stringify(opts.config))}`;
      contentType = "application/x-www-form-urlencoded";
    }

    if (method !== "GET") {
      // Non-PII audit trail for state-changing calls (surfaced via `wrangler tail`).
      try {
        console.log(`[zoho-analytics-mcp] ${method} ${path}`);
      } catch {
        /* ignore */
      }
    }

    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const token = await this.getAccessToken();
      const headers: Record<string, string> = {
        Authorization: `Zoho-oauthtoken ${token}`,
        Accept: "application/json",
      };
      if (this.orgId) headers["ZANALYTICS-ORGID"] = this.orgId;
      if (contentType) headers["Content-Type"] = contentType;
      if (opts.headers) Object.assign(headers, opts.headers);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await fetch(url, { method, headers, body, signal: controller.signal });
        clearTimeout(timer);
        const text = await res.text();

        // The token may have been revoked/expired server-side before our cached
        // expiry. Refresh once and retry immediately.
        if (res.status === 401 && !refreshed && !this.staticAccessToken) {
          refreshed = true;
          this.accessToken = undefined;
          this.accessTokenExpiry = 0;
          continue;
        }

        const retryable = isIdempotent && (res.status === 429 || res.status >= 500);
        if (res.ok || !retryable || attempt >= this.maxRetries) {
          return { res, text };
        }
        await this.backoff(attempt, res.headers.get("retry-after"));
      } catch (err) {
        clearTimeout(timer);
        // Network error or timeout (AbortError). Retry idempotent calls only.
        if (!isIdempotent || attempt >= this.maxRetries) {
          const reason = err instanceof Error ? err.message : String(err);
          throw new Error(`Zoho Analytics request failed (${method} ${path}): ${reason}`);
        }
        await this.backoff(attempt, null);
      }
    }
  }

  /** Call returning the standard JSON envelope; throws ZohoAnalyticsError on failure. */
  private async request<T = unknown>(method: string, path: string, opts: CoreOptions = {}): Promise<T> {
    const { res, text } = await this.core(method, path, opts);
    let parsed: { status?: string; data?: { errorCode?: number; errorMessage?: string } } | null = null;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = null;
    }
    if (!res.ok || parsed?.status === "failure") {
      const code = parsed?.data?.errorCode ?? null;
      const msg = parsed?.data?.errorMessage ?? (text || res.statusText);
      throw new ZohoAnalyticsError(res.status, code, typeof msg === "string" ? msg : JSON.stringify(msg), method, path);
    }
    // Many mutations return 204 No Content; surface a clear success marker.
    if (!text) return { status: "success" } as T;
    return (parsed ?? {}) as T;
  }

  /**
   * Call returning a raw body (the synchronous Export and the Bulk Download
   * endpoints stream file bytes, not the JSON envelope). Errors still arrive as
   * a JSON failure envelope, which we detect and throw.
   */
  private async requestRaw(method: string, path: string, opts: CoreOptions = {}): Promise<string> {
    const { res, text } = await this.core(method, path, opts);
    const asFailure = () => {
      try {
        const p = JSON.parse(text) as { status?: string; data?: { errorCode?: number; errorMessage?: string } };
        if (p?.status === "failure") {
          return new ZohoAnalyticsError(res.status, p.data?.errorCode ?? null, p.data?.errorMessage ?? text, method, path);
        }
      } catch {
        /* not an envelope */
      }
      return null;
    };
    if (!res.ok) {
      throw asFailure() ?? new ZohoAnalyticsError(res.status, null, text || res.statusText, method, path);
    }
    const maybe = asFailure();
    if (maybe) throw maybe;
    return text;
  }

  // ============================ Metadata API ============================

  /** List the organizations this token can access (use to discover your org id). */
  getOrgs() {
    return this.request("GET", "/orgs");
  }
  /** All workspaces: data.ownedWorkspaces[] and data.sharedWorkspaces[]. */
  getWorkspaces() {
    return this.request("GET", "/workspaces");
  }
  getOwnedWorkspaces() {
    return this.request("GET", "/workspaces/owned");
  }
  getSharedWorkspaces() {
    return this.request("GET", "/workspaces/shared");
  }
  getWorkspaceDetails(workspaceId: string) {
    return this.request("GET", `/workspaces/${workspaceId}`);
  }
  /** Views in a workspace. config: { viewTypes?: number[], keyword?, startIndex?, noOfResult? }. */
  getViews(workspaceId: string, config?: Config) {
    return this.request("GET", `/workspaces/${workspaceId}/views`, { config });
  }
  /** View details (note: org-level path). config: { withInvolvedMetaInfo?: true } adds column metadata. */
  getViewDetails(viewId: string, config?: Config) {
    return this.request("GET", `/views/${viewId}`, { config });
  }
  /** Workspace/view + column metadata looked up by NAME. config: { workspaceName, viewName? }. */
  getMetaDetails(workspaceName: string, viewName?: string) {
    const config: Config = { workspaceName };
    if (viewName) config.viewName = viewName;
    return this.request("GET", "/metadetails", { config });
  }
  /** Table metadata (columns) for a view. */
  getViewMetadata(workspaceId: string, viewId: string) {
    return this.request("GET", `/workspaces/${workspaceId}/views/${viewId}/metadata`);
  }
  getQueryTableDetails(workspaceId: string, queryTableId: string) {
    return this.request("GET", `/workspaces/${workspaceId}/querytables/${queryTableId}`);
  }
  getFolders(workspaceId: string) {
    return this.request("GET", `/workspaces/${workspaceId}/folders`);
  }
  getDashboards() {
    return this.request("GET", "/dashboards");
  }
  getRecentViews() {
    return this.request("GET", "/recentviews");
  }
  getTrashViews(workspaceId: string) {
    return this.request("GET", `/workspaces/${workspaceId}/trash`);
  }
  getDatasources(workspaceId: string, viewId: string) {
    return this.request("GET", `/workspaces/${workspaceId}/views/${viewId}/datasources`);
  }

  // ============================ Data API (synchronous) ============================

  /**
   * Export the rows of a table/view. Returns the RAW body (JSON/CSV/...).
   * Not allowed for views > 1,000,000 rows, live-connect workspaces, or
   * Dashboard/Query-Table views — use the bulk export job for those.
   */
  exportData(workspaceId: string, viewId: string, config: Config): Promise<string> {
    return this.requestRaw("GET", `/workspaces/${workspaceId}/views/${viewId}/data`, { config });
  }
  /** Add a single row. config: { columns: { name: value, ... }, dateFormat? }. */
  addRow(workspaceId: string, viewId: string, config: Config) {
    return this.request("POST", `/workspaces/${workspaceId}/views/${viewId}/rows`, { config });
  }
  /** Update rows. config: { columns, criteria?, updateAllRows?, addIfNotExist? }. */
  updateRows(workspaceId: string, viewId: string, config: Config) {
    return this.request("PUT", `/workspaces/${workspaceId}/views/${viewId}/rows`, { config });
  }
  /** Delete rows. config: { criteria } or { deleteAllRows: true }. */
  deleteRows(workspaceId: string, viewId: string, config: Config) {
    return this.request("DELETE", `/workspaces/${workspaceId}/views/${viewId}/rows`, { config });
  }
  /** Sort a view's data. Takes a raw JSON body: { columns, sortOrder (1=asc,2=desc), resetSort? }. */
  sortData(workspaceId: string, viewId: string, body: Config) {
    return this.request("PUT", `/workspaces/${workspaceId}/views/${viewId}/data/sort`, { jsonBody: body });
  }

  // ============================ Bulk API (asynchronous) ============================

  /** Create an export job from a SQL query. Returns envelope with data.jobId. */
  createExportJobBySql(workspaceId: string, sqlQuery: string, responseFormat: ResponseFormat = "json") {
    return this.request("GET", `/bulk/workspaces/${workspaceId}/data`, {
      config: { responseFormat, sqlQuery },
    });
  }
  /** Create an export job for an entire view. config: { responseFormat (required), criteria?, ... }. */
  createExportJobByView(workspaceId: string, viewId: string, config: Config) {
    return this.request("GET", `/bulk/workspaces/${workspaceId}/views/${viewId}/data`, { config });
  }
  /** Poll an export job. Returns envelope with data.jobCode/jobStatus/downloadUrl. */
  getExportJobStatus(workspaceId: string, jobId: string) {
    return this.request("GET", `/bulk/workspaces/${workspaceId}/exportjobs/${jobId}`);
  }
  /** Download a completed export job's data (raw body). */
  downloadExportData(workspaceId: string, jobId: string): Promise<string> {
    return this.requestRaw("GET", `/bulk/workspaces/${workspaceId}/exportjobs/${jobId}/data`);
  }
  /**
   * Create a bulk import job. The file rides as a multipart field named FILE.
   * config: { importType, fileType, autoIdentify, onError, matchingColumns?, ... }.
   */
  createImportJob(
    workspaceId: string,
    viewId: string,
    file: { content: string; name: string; type?: string },
    config: Config,
  ) {
    const form = new FormData();
    form.append("FILE", new Blob([file.content], { type: file.type ?? "text/csv" }), file.name);
    return this.request("POST", `/bulk/workspaces/${workspaceId}/views/${viewId}/data`, { config, form });
  }
  /** Create an import job that also CREATES a new table from the uploaded data. config: { tableName, fileType, autoIdentify, ... }. */
  createTableFromData(
    workspaceId: string,
    file: { content: string; name: string; type?: string },
    config: Config,
  ) {
    const form = new FormData();
    form.append("FILE", new Blob([file.content], { type: file.type ?? "text/csv" }), file.name);
    return this.request("POST", `/bulk/workspaces/${workspaceId}/data`, { config, form });
  }
  /** Poll an import job. Returns envelope with data.jobCode/jobStatus/jobInfo.importSummary. */
  getImportJobStatus(workspaceId: string, jobId: string) {
    return this.request("GET", `/bulk/workspaces/${workspaceId}/importjobs/${jobId}`);
  }

  // ============================ Modeling: workspaces ============================

  createWorkspace(workspaceName: string, workspaceDesc?: string) {
    const config: Config = { workspaceName };
    if (workspaceDesc) config.workspaceDesc = workspaceDesc;
    return this.request("POST", "/workspaces", { config });
  }
  renameWorkspace(workspaceId: string, config: Config) {
    return this.request("PUT", `/workspaces/${workspaceId}`, { config });
  }
  /** Permanently delete a workspace (workspaces are not trashed). Irreversible. */
  deleteWorkspace(workspaceId: string) {
    return this.request("DELETE", `/workspaces/${workspaceId}`);
  }
  /** Copy a workspace. config: { newWorkspaceName, newWorkspaceDesc?, workspaceKey?, copyWithData? }. destOrgId for cross-org. */
  copyWorkspace(workspaceId: string, config: Config, destOrgId?: string) {
    return this.request("POST", `/workspaces/${workspaceId}`, {
      config,
      headers: destOrgId ? { "ZANALYTICS-DEST-ORGID": destOrgId } : undefined,
    });
  }
  /** Get (or regenerate, with config { regenerateKey: true }) the workspace secret key for cross-org copies. */
  getWorkspaceSecretKey(workspaceId: string, config?: Config) {
    return this.request("GET", `/workspaces/${workspaceId}/secretkey`, { config });
  }
  /** Copy views to another workspace/org. config: { viewIds, destWorkspaceId, workspaceKey?, copyWithData? }. destOrgId required. */
  copyViews(workspaceId: string, config: Config, destOrgId: string) {
    return this.request("POST", `/workspaces/${workspaceId}/views/copy`, {
      config,
      headers: { "ZANALYTICS-DEST-ORGID": destOrgId },
    });
  }

  // ============================ Modeling: tables / query tables / reports ============================

  /** Create a table. config: { tableDesign: { TABLENAME, COLUMNS: [...] } }. */
  createTable(workspaceId: string, tableDesign: Config) {
    return this.request("POST", `/workspaces/${workspaceId}/tables`, { config: { tableDesign } });
  }
  /** Create a query (SQL-backed) table. config: { sqlQuery, queryTableName, description?, folderId? }. */
  createQueryTable(workspaceId: string, config: Config) {
    return this.request("POST", `/workspaces/${workspaceId}/querytables`, { config });
  }
  /** Edit a query table. config: { sqlQuery, folderId? }. */
  editQueryTable(workspaceId: string, queryTableId: string, config: Config) {
    return this.request("PUT", `/workspaces/${workspaceId}/querytables/${queryTableId}`, { config });
  }
  /** Create a report (chart/pivot/summary). config: { baseTableName, title, reportType, chartType?, axisColumns[], ... }. */
  createReport(workspaceId: string, config: Config) {
    return this.request("POST", `/workspaces/${workspaceId}/reports`, { config });
  }
  updateReport(workspaceId: string, reportId: string, config: Config) {
    return this.request("PUT", `/workspaces/${workspaceId}/reports/${reportId}`, { config });
  }

  // ============================ Modeling: columns ============================

  /** Add a column. config: { columnName, dataType, isPIIColumn?, geoRole? }. */
  addColumn(workspaceId: string, viewId: string, config: Config) {
    return this.request("POST", `/workspaces/${workspaceId}/views/${viewId}/columns`, { config });
  }
  renameColumn(workspaceId: string, viewId: string, columnId: string, config: Config) {
    return this.request("PUT", `/workspaces/${workspaceId}/views/${viewId}/columns/${columnId}`, { config });
  }
  deleteColumn(workspaceId: string, viewId: string, columnId: string, config?: Config) {
    return this.request("DELETE", `/workspaces/${workspaceId}/views/${viewId}/columns/${columnId}`, { config });
  }
  /** Hide columns. config: { columnIds: [...] }. */
  hideColumns(workspaceId: string, viewId: string, columnIds: string[]) {
    return this.request("PUT", `/workspaces/${workspaceId}/views/${viewId}/columns/hide`, { config: { columnIds } });
  }
  showColumns(workspaceId: string, viewId: string, columnIds: string[]) {
    return this.request("PUT", `/workspaces/${workspaceId}/views/${viewId}/columns/show`, { config: { columnIds } });
  }
  /** Reorder columns. `columns` must list ALL column ids in the desired order. */
  reorderColumns(workspaceId: string, viewId: string, columns: string[]) {
    return this.request("PUT", `/workspaces/${workspaceId}/views/${viewId}/columns/reorder`, { config: { columns } });
  }
  /** Add a lookup. config: { referenceViewId, referenceColumnId }. */
  addLookup(workspaceId: string, viewId: string, columnId: string, config: Config) {
    return this.request("POST", `/workspaces/${workspaceId}/views/${viewId}/columns/${columnId}/lookup`, { config });
  }
  removeLookup(workspaceId: string, viewId: string, columnId: string, config?: Config) {
    return this.request("DELETE", `/workspaces/${workspaceId}/views/${viewId}/columns/${columnId}/lookup`, { config });
  }

  // ============================ Modeling: formulas ============================

  /** Add an inline/custom formula column. config: { formulaName, expression, description? }. */
  addFormulaColumn(workspaceId: string, viewId: string, config: Config) {
    return this.request("POST", `/workspaces/${workspaceId}/views/${viewId}/customformulas`, { config });
  }
  deleteFormulaColumn(workspaceId: string, viewId: string, formulaId: string, config?: Config) {
    return this.request("DELETE", `/workspaces/${workspaceId}/views/${viewId}/customformulas/${formulaId}`, { config });
  }
  /** Add an aggregate formula. config: { formulaName, expression, description? }. */
  addAggregateFormula(workspaceId: string, viewId: string, config: Config) {
    return this.request("POST", `/workspaces/${workspaceId}/views/${viewId}/aggregateformulas`, { config });
  }
  deleteAggregateFormula(workspaceId: string, viewId: string, formulaId: string, config?: Config) {
    return this.request("DELETE", `/workspaces/${workspaceId}/views/${viewId}/aggregateformulas/${formulaId}`, { config });
  }

  // ============================ Modeling: folders ============================

  /** config: { folderName, folderDesc?, parentFolderId?, makeDefaultFolder? }. */
  createFolder(workspaceId: string, config: Config) {
    return this.request("POST", `/workspaces/${workspaceId}/folders`, { config });
  }
  renameFolder(workspaceId: string, folderId: string, config: Config) {
    return this.request("PUT", `/workspaces/${workspaceId}/folders/${folderId}`, { config });
  }
  deleteFolder(workspaceId: string, folderId: string, config?: Config) {
    return this.request("DELETE", `/workspaces/${workspaceId}/folders/${folderId}`, { config });
  }

  // ============================ Modeling: views ============================

  /** Rename a view. config: { viewName, viewDesc? }. */
  renameView(workspaceId: string, viewId: string, config: Config) {
    return this.request("PUT", `/workspaces/${workspaceId}/views/${viewId}`, { config });
  }
  /** Copy a view. config: { viewName, viewDesc?, copyWithData?, copyWithLookup?, folderId? }. */
  saveAsView(workspaceId: string, viewId: string, config: Config) {
    return this.request("POST", `/workspaces/${workspaceId}/views/${viewId}/saveas`, { config });
  }
  /** Move a view/table to trash (DELETE). config: { deleteDependentViews? }. */
  deleteView(workspaceId: string, viewId: string, config?: Config) {
    return this.request("DELETE", `/workspaces/${workspaceId}/views/${viewId}`, { config });
  }
  /** Move views into a folder. config: { folderId, viewIds: [...] }. */
  moveViewsToFolder(workspaceId: string, config: Config) {
    return this.request("PUT", `/workspaces/${workspaceId}/views/movetofolder`, { config });
  }
  /** Restore a view from trash. config: { withDependents? }. */
  restoreTrashView(workspaceId: string, viewId: string, config?: Config) {
    return this.request("POST", `/workspaces/${workspaceId}/trash/${viewId}`, { config });
  }
  /** Permanently delete a view from trash. config: { withDependents? }. */
  deleteTrashView(workspaceId: string, viewId: string, config?: Config) {
    return this.request("DELETE", `/workspaces/${workspaceId}/trash/${viewId}`, { config });
  }

  // ============================ Sharing API ============================

  /** config: { emailIds, viewIds, permissions:{read,...}, groupIds?, criteria?, inviteMail?, ... }. */
  shareViews(workspaceId: string, config: Config) {
    return this.request("POST", `/workspaces/${workspaceId}/views/share`, { config });
  }
  updateSharedViews(workspaceId: string, config: Config) {
    return this.request("PUT", `/workspaces/${workspaceId}/views/share`, { config });
  }
  /** config: { emailIds, viewIds?, removeAllViews?, groupIds? }. */
  removeShare(workspaceId: string, config: Config) {
    return this.request("DELETE", `/workspaces/${workspaceId}/views/share`, { config });
  }
  getSharedDetails(workspaceId: string, viewIds: string[]) {
    return this.request("GET", `/workspaces/${workspaceId}/share/shareddetails`, { config: { viewIds } });
  }
  getWorkspaceSharedDetails(workspaceId: string) {
    return this.request("GET", `/workspaces/${workspaceId}/share`);
  }
  getMyPermissions(workspaceId: string, viewId: string) {
    return this.request("GET", `/workspaces/${workspaceId}/views/${viewId}/share/mypermissions`);
  }
  getWorkspaceAdmins(workspaceId: string) {
    return this.request("GET", `/workspaces/${workspaceId}/admins`);
  }
  /** config: { emailIds, inviteMail? }. */
  addWorkspaceAdmins(workspaceId: string, config: Config) {
    return this.request("POST", `/workspaces/${workspaceId}/admins`, { config });
  }
  removeWorkspaceAdmins(workspaceId: string, config: Config) {
    return this.request("DELETE", `/workspaces/${workspaceId}/admins`, { config });
  }
  getOrgAdmins() {
    return this.request("GET", "/orgadmins");
  }
  getGroups(workspaceId: string) {
    return this.request("GET", `/workspaces/${workspaceId}/groups`);
  }
  /** config: { groupName, emailIds, groupDesc?, inviteMail? }. */
  createGroup(workspaceId: string, config: Config) {
    return this.request("POST", `/workspaces/${workspaceId}/groups`, { config });
  }
  getGroupDetails(workspaceId: string, groupId: string) {
    return this.request("GET", `/workspaces/${workspaceId}/groups/${groupId}`);
  }
  renameGroup(workspaceId: string, groupId: string, config: Config) {
    return this.request("PUT", `/workspaces/${workspaceId}/groups/${groupId}`, { config });
  }
  deleteGroup(workspaceId: string, groupId: string) {
    return this.request("DELETE", `/workspaces/${workspaceId}/groups/${groupId}`);
  }
  addGroupMembers(workspaceId: string, groupId: string, config: Config) {
    return this.request("POST", `/workspaces/${workspaceId}/groups/${groupId}/members`, { config });
  }
  removeGroupMembers(workspaceId: string, groupId: string, config: Config) {
    return this.request("DELETE", `/workspaces/${workspaceId}/groups/${groupId}/members`, { config });
  }

  // ============================ User Management API ============================

  getUsers() {
    return this.request("GET", "/users");
  }
  /** config: { emailIds, role? (USER|VIEWER|ORGADMIN) }. */
  addUsers(config: Config) {
    return this.request("POST", "/users", { config });
  }
  removeUsers(config: Config) {
    return this.request("DELETE", "/users", { config });
  }
  activateUsers(config: Config) {
    return this.request("PUT", "/users/active", { config });
  }
  deactivateUsers(config: Config) {
    return this.request("PUT", "/users/inactive", { config });
  }
  /** config: { emailIds, role (USER|VIEWER|ORGADMIN) }. */
  changeUserRole(config: Config) {
    return this.request("PUT", "/users/role", { config });
  }
  getSubscription() {
    return this.request("GET", "/subscription");
  }
  getResources() {
    return this.request("GET", "/resources");
  }
  getWorkspaceUsers(workspaceId: string) {
    return this.request("GET", `/workspaces/${workspaceId}/users`);
  }
  addWorkspaceUsers(workspaceId: string, config: Config) {
    return this.request("POST", `/workspaces/${workspaceId}/users`, { config });
  }
  deleteWorkspaceUsers(workspaceId: string, config: Config) {
    return this.request("DELETE", `/workspaces/${workspaceId}/users`, { config });
  }
  /** config: { emailIds, operation (activate|deactivate) }. */
  changeWorkspaceUsersStatus(workspaceId: string, config: Config) {
    return this.request("PUT", `/workspaces/${workspaceId}/users/status`, { config });
  }
  /** config: { emailIds, role (USER|WORKSPACEADMIN|<custom>) }. */
  changeWorkspaceUsersRole(workspaceId: string, config: Config) {
    return this.request("PUT", `/workspaces/${workspaceId}/users/role`, { config });
  }

  // ============================ Embed / publish API ============================

  getViewUrl(workspaceId: string, viewId: string, config?: Config): Promise<unknown> {
    return this.request("GET", `/workspaces/${workspaceId}/views/${viewId}/publish`, { config });
  }
  getEmbedUrl(workspaceId: string, viewId: string, config?: Config) {
    return this.request("GET", `/workspaces/${workspaceId}/views/${viewId}/publish/embed`, { config });
  }
  getPrivateUrl(workspaceId: string, viewId: string, config?: Config) {
    return this.request("GET", `/workspaces/${workspaceId}/views/${viewId}/publish/privatelink`, { config });
  }
  createPrivateUrl(workspaceId: string, viewId: string, config?: Config) {
    return this.request("POST", `/workspaces/${workspaceId}/views/${viewId}/publish/privatelink`, { config });
  }
  removePrivateUrl(workspaceId: string, viewId: string) {
    return this.request("DELETE", `/workspaces/${workspaceId}/views/${viewId}/publish/privatelink`);
  }
  /** config: { publicPermLevel?, permissions?, criteria? }. */
  makeViewPublic(workspaceId: string, viewId: string, config?: Config) {
    return this.request("POST", `/workspaces/${workspaceId}/views/${viewId}/publish/public`, { config });
  }
  removePublic(workspaceId: string, viewId: string) {
    return this.request("DELETE", `/workspaces/${workspaceId}/views/${viewId}/publish/public`);
  }
  getPublishConfig(workspaceId: string, viewId: string) {
    return this.request("GET", `/workspaces/${workspaceId}/views/${viewId}/publish/config`);
  }
  updatePublishConfig(workspaceId: string, viewId: string, config: Config) {
    return this.request("PUT", `/workspaces/${workspaceId}/views/${viewId}/publish/config`, { config });
  }
  getSlideshows(workspaceId: string) {
    return this.request("GET", `/workspaces/${workspaceId}/slides`);
  }
  /** config: { slideName, viewIds, accessType? }. */
  createSlideshow(workspaceId: string, config: Config) {
    return this.request("POST", `/workspaces/${workspaceId}/slides`, { config });
  }
  getSlideshowDetails(workspaceId: string, slideId: string) {
    return this.request("GET", `/workspaces/${workspaceId}/slides/${slideId}`);
  }
  updateSlideshow(workspaceId: string, slideId: string, config: Config) {
    return this.request("PUT", `/workspaces/${workspaceId}/slides/${slideId}`, { config });
  }
  deleteSlideshow(workspaceId: string, slideId: string) {
    return this.request("DELETE", `/workspaces/${workspaceId}/slides/${slideId}`);
  }
  getSlideshowUrl(workspaceId: string, slideId: string, config?: Config) {
    return this.request("GET", `/workspaces/${workspaceId}/slides/${slideId}/publish`, { config });
  }

  // ============================ Variables ============================

  getVariables(workspaceId: string) {
    return this.request("GET", `/workspaces/${workspaceId}/variables`);
  }
  /** config: { variableName, variableType, variableDataType, defaultData?, ... }. */
  createVariable(workspaceId: string, config: Config) {
    return this.request("POST", `/workspaces/${workspaceId}/variables`, { config });
  }
  getVariableDetails(workspaceId: string, variableId: string) {
    return this.request("GET", `/workspaces/${workspaceId}/variables/${variableId}`);
  }
  updateVariable(workspaceId: string, variableId: string, config: Config) {
    return this.request("PUT", `/workspaces/${workspaceId}/variables/${variableId}`, { config });
  }
  deleteVariable(workspaceId: string, variableId: string) {
    return this.request("DELETE", `/workspaces/${workspaceId}/variables/${variableId}`);
  }
}
