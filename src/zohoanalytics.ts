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
  cn: { api: "analyticsapi.zoho.com.cn", accounts: "accounts.zoho.com.cn" },
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
  IN_PROGRESS_A: "1001", // JOB NOT INITIATED
  IN_PROGRESS_B: "1002", // JOB IN PROGRESS
  ERROR: "1003", //         ERROR OCCURRED — stop polling, inspect the error message
  COMPLETED: "1004", //     JOB COMPLETED
  INVALID: "1005", //       JOB NOT FOUND
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

/** Encode a caller-supplied id before it is interpolated into an API path. */
const enc = encodeURIComponent;

/**
 * Cross-instance access-token cache. Each MCP session runs in its own Durable
 * Object with its own client, so without a shared store every new session mints
 * its own access token — and Zoho caps token creation (~10 per 10 min per
 * refresh token). Back this with Workers KV to share one token across sessions.
 */
export interface TokenStore {
  get(): Promise<{ token: string; expiry: number } | null>;
  set(token: string, expiry: number): Promise<void>;
}

/** TokenStore backed by a Workers KV namespace (structurally typed; pass any KV binding). */
export function kvTokenStore(kv: {
  get(key: string, type: "json"): Promise<unknown>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}): TokenStore {
  const KEY = "zoho-analytics:access-token";
  return {
    async get() {
      try {
        const v = (await kv.get(KEY, "json")) as { token?: unknown; expiry?: unknown } | null;
        if (v && typeof v.token === "string" && typeof v.expiry === "number") {
          return { token: v.token, expiry: v.expiry };
        }
      } catch {
        /* a broken KV read must never block auth — fall back to a fresh mint */
      }
      return null;
    },
    async set(token, expiry) {
      try {
        const ttl = Math.max(60, Math.floor((expiry - Date.now()) / 1000) - 60);
        await kv.put(KEY, JSON.stringify({ token, expiry }), { expirationTtl: ttl });
      } catch {
        /* best-effort */
      }
    },
  };
}

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
  /** Data-center key: com | eu | in | au | jp | sa | ca | uk | cn. Default "com". */
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
  /** Optional cross-instance access-token cache (see kvTokenStore). */
  tokenStore?: TokenStore;
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
  /** Read the response as binary and return it base64-encoded (template export ZIPs). */
  binary?: boolean;
}

/** Base64-encode an ArrayBuffer in chunks (btoa exists in Workers and Node >= 16). */
function b64encode(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
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
  // In-flight refresh shared by concurrent callers (single-flight).
  private refreshPromise?: Promise<string>;
  // Optional cross-instance token cache (KV) shared by all sessions.
  private tokenStore?: TokenStore;

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
    this.tokenStore = opts.tokenStore;
  }

  // ---- OAuth token management ----

  /** Return a valid access token, refreshing it if absent/expired (60s skew buffer). */
  private async getAccessToken(): Promise<string> {
    if (this.staticAccessToken) return this.staticAccessToken;
    if (this.accessToken && Date.now() < this.accessTokenExpiry - 60_000) {
      return this.accessToken;
    }
    // Single-flight: concurrent callers (e.g. a mapLimit batch on a cold isolate)
    // share one refresh instead of stampeding the token endpoint — Zoho rate-limits
    // access-token creation per refresh token (~10 per 10 minutes).
    this.refreshPromise ??= this.acquireAccessToken().finally(() => {
      this.refreshPromise = undefined;
    });
    return this.refreshPromise;
  }

  /** Check the shared cross-instance store first; only mint a new token on a miss. */
  private async acquireAccessToken(): Promise<string> {
    if (this.tokenStore) {
      const stored = await this.tokenStore.get();
      if (stored && Date.now() < stored.expiry - 60_000) {
        this.accessToken = stored.token;
        this.accessTokenExpiry = stored.expiry;
        return stored.token;
      }
    }
    const token = await this.refreshAccessToken();
    if (this.tokenStore) {
      await this.tokenStore.set(token, this.accessTokenExpiry);
    }
    return token;
  }

  /** Exchange the refresh token for a fresh access token at the accounts endpoint. */
  private async refreshAccessToken(): Promise<string> {
    if (!this.refreshToken || !this.clientId || !this.clientSecret) {
      throw new Error("Cannot refresh: missing refreshToken/clientId/clientSecret.");
    }
    // Credentials travel in the POST body, never the URL — query strings are
    // routinely captured by access logs, proxies, and TLS-inspection middleboxes.
    const params = new URLSearchParams({
      refresh_token: this.refreshToken,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      grant_type: "refresh_token",
    });
    const url = `${this.accountsOrigin}/oauth/v2/token`;

    let lastErr = "";
    for (let attempt = 0; attempt <= 2; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: params.toString(),
          signal: controller.signal,
        });
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
        if (res.status < 500 && res.status !== 429) break; // permanent client error -> don't retry (429 is transient)
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
      // Cap server-provided Retry-After so a 429 inside a polling tool call
      // can't sleep past the caller's deadline / the MCP client's timeout.
      delayMs = Math.min(secs * 1000, 8000);
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
        // Binary reads only apply to OK responses; error bodies stay text so the
        // failure envelope can be parsed. A body starting with "{" is a JSON
        // envelope (Zoho reports some failures with HTTP 200), never a ZIP — decode
        // it as text so requestRaw's failure detection still fires.
        let text: string;
        if (opts.binary && res.ok) {
          const buf = await res.arrayBuffer();
          text = new Uint8Array(buf)[0] === 0x7b ? new TextDecoder().decode(buf) : b64encode(buf);
        } else {
          text = await res.text();
        }

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
    return this.request("GET", `/workspaces/${enc(workspaceId)}`);
  }
  /** Views in a workspace. config: { viewTypes?: number[], keyword?, startIndex?, noOfResult? }. */
  getViews(workspaceId: string, config?: Config) {
    return this.request("GET", `/workspaces/${enc(workspaceId)}/views`, { config });
  }
  /** View details (note: org-level path). config: { withInvolvedMetaInfo?: true } adds column metadata. */
  getViewDetails(viewId: string, config?: Config) {
    return this.request("GET", `/views/${enc(viewId)}`, { config });
  }
  /** Workspace/view + column metadata looked up by NAME. config: { workspaceName, viewName? }. */
  getMetaDetails(workspaceName: string, viewName?: string) {
    const config: Config = { workspaceName };
    if (viewName) config.viewName = viewName;
    return this.request("GET", "/metadetails", { config });
  }
  /** Table metadata (columns) for a view. */
  getViewMetadata(workspaceId: string, viewId: string) {
    return this.request("GET", `/workspaces/${enc(workspaceId)}/views/${enc(viewId)}/metadata`);
  }
  getQueryTableDetails(workspaceId: string, queryTableId: string) {
    return this.request("GET", `/workspaces/${enc(workspaceId)}/querytables/${enc(queryTableId)}`);
  }
  getFolders(workspaceId: string) {
    return this.request("GET", `/workspaces/${enc(workspaceId)}/folders`);
  }
  getDashboards() {
    return this.request("GET", "/dashboards");
  }
  getRecentViews() {
    return this.request("GET", "/recentviews");
  }
  getTrashViews(workspaceId: string) {
    return this.request("GET", `/workspaces/${enc(workspaceId)}/trash`);
  }
  getDatasources(workspaceId: string, viewId: string) {
    return this.request("GET", `/workspaces/${enc(workspaceId)}/views/${enc(viewId)}/datasources`);
  }

  // ============================ Data API (synchronous) ============================

  /**
   * Export the rows of a table/view. Returns the RAW body (JSON/CSV/...).
   * Not allowed for views > 1,000,000 rows, live-connect workspaces, or
   * Dashboard/Query-Table views — use the bulk export job for those.
   */
  exportData(workspaceId: string, viewId: string, config: Config): Promise<string> {
    return this.requestRaw("GET", `/workspaces/${enc(workspaceId)}/views/${enc(viewId)}/data`, { config });
  }
  /** Add a single row. config: { columns: { name: value, ... }, dateFormat? }. */
  addRow(workspaceId: string, viewId: string, config: Config) {
    return this.request("POST", `/workspaces/${enc(workspaceId)}/views/${enc(viewId)}/rows`, { config });
  }
  /** Update rows. config: { columns, criteria?, updateAllRows?, addIfNotExist? }. */
  updateRows(workspaceId: string, viewId: string, config: Config) {
    return this.request("PUT", `/workspaces/${enc(workspaceId)}/views/${enc(viewId)}/rows`, { config });
  }
  /** Delete rows. config: { criteria } or { deleteAllRows: true }. */
  deleteRows(workspaceId: string, viewId: string, config: Config) {
    return this.request("DELETE", `/workspaces/${enc(workspaceId)}/views/${enc(viewId)}/rows`, { config });
  }
  /** Sort a view's data. Takes a raw JSON body: { columns, sortOrder (1=asc,2=desc), resetSort? }. */
  sortData(workspaceId: string, viewId: string, body: Config) {
    return this.request("PUT", `/workspaces/${enc(workspaceId)}/views/${enc(viewId)}/data/sort`, { jsonBody: body });
  }

  // ============================ Bulk API (asynchronous) ============================

  /** Create an export job from a SQL query. Returns envelope with data.jobId. */
  createExportJobBySql(workspaceId: string, sqlQuery: string, responseFormat: ResponseFormat = "json") {
    return this.request("GET", `/bulk/workspaces/${enc(workspaceId)}/data`, {
      config: { responseFormat, sqlQuery },
    });
  }
  /** Create an export job for an entire view. config: { responseFormat (required), criteria?, ... }. */
  createExportJobByView(workspaceId: string, viewId: string, config: Config) {
    return this.request("GET", `/bulk/workspaces/${enc(workspaceId)}/views/${enc(viewId)}/data`, { config });
  }
  /** Poll an export job. Returns envelope with data.jobCode/jobStatus/downloadUrl. */
  getExportJobStatus(workspaceId: string, jobId: string) {
    return this.request("GET", `/bulk/workspaces/${enc(workspaceId)}/exportjobs/${enc(jobId)}`);
  }
  /** Download a completed export job's data (raw body). */
  downloadExportData(workspaceId: string, jobId: string): Promise<string> {
    return this.requestRaw("GET", `/bulk/workspaces/${enc(workspaceId)}/exportjobs/${enc(jobId)}/data`);
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
    return this.request("POST", `/bulk/workspaces/${enc(workspaceId)}/views/${enc(viewId)}/data`, { config, form });
  }
  /** Create an import job that also CREATES a new table from the uploaded data. config: { tableName, fileType, autoIdentify, ... }. */
  createTableFromData(
    workspaceId: string,
    file: { content: string; name: string; type?: string },
    config: Config,
  ) {
    const form = new FormData();
    form.append("FILE", new Blob([file.content], { type: file.type ?? "text/csv" }), file.name);
    return this.request("POST", `/bulk/workspaces/${enc(workspaceId)}/data`, { config, form });
  }
  /** Poll an import job. Returns envelope with data.jobCode/jobStatus/jobInfo.importSummary. */
  getImportJobStatus(workspaceId: string, jobId: string) {
    return this.request("GET", `/bulk/workspaces/${enc(workspaceId)}/importjobs/${enc(jobId)}`);
  }

  // ============================ Modeling: workspaces ============================

  createWorkspace(workspaceName: string, workspaceDesc?: string) {
    const config: Config = { workspaceName };
    if (workspaceDesc) config.workspaceDesc = workspaceDesc;
    return this.request("POST", "/workspaces", { config });
  }
  renameWorkspace(workspaceId: string, config: Config) {
    return this.request("PUT", `/workspaces/${enc(workspaceId)}`, { config });
  }
  /** Permanently delete a workspace (workspaces are not trashed). Irreversible. */
  deleteWorkspace(workspaceId: string) {
    return this.request("DELETE", `/workspaces/${enc(workspaceId)}`);
  }
  /** Copy a workspace. config: { newWorkspaceName, newWorkspaceDesc?, workspaceKey?, copyWithData? }. destOrgId for cross-org. */
  copyWorkspace(workspaceId: string, config: Config, destOrgId?: string) {
    return this.request("POST", `/workspaces/${enc(workspaceId)}`, {
      config,
      headers: destOrgId ? { "ZANALYTICS-DEST-ORGID": destOrgId } : undefined,
    });
  }
  /** Get (or regenerate, with config { regenerateKey: true }) the workspace secret key for cross-org copies. */
  getWorkspaceSecretKey(workspaceId: string, config?: Config) {
    return this.request("GET", `/workspaces/${enc(workspaceId)}/secretkey`, { config });
  }
  /** Copy views to another workspace/org. config: { viewIds, destWorkspaceId, workspaceKey?, copyWithData? }. destOrgId required. */
  copyViews(workspaceId: string, config: Config, destOrgId: string) {
    return this.request("POST", `/workspaces/${enc(workspaceId)}/views/copy`, {
      config,
      headers: { "ZANALYTICS-DEST-ORGID": destOrgId },
    });
  }

  // ============================ Modeling: tables / query tables / reports ============================

  /** Create a table. config: { tableDesign: { TABLENAME, COLUMNS: [...] } }. */
  createTable(workspaceId: string, tableDesign: Config) {
    return this.request("POST", `/workspaces/${enc(workspaceId)}/tables`, { config: { tableDesign } });
  }
  /** Create a query (SQL-backed) table. config: { sqlQuery, queryTableName, description?, folderId? }. */
  createQueryTable(workspaceId: string, config: Config) {
    return this.request("POST", `/workspaces/${enc(workspaceId)}/querytables`, { config });
  }
  /** Edit a query table. config: { sqlQuery, folderId? }. */
  editQueryTable(workspaceId: string, queryTableId: string, config: Config) {
    return this.request("PUT", `/workspaces/${enc(workspaceId)}/querytables/${enc(queryTableId)}`, { config });
  }
  /** Create a report (chart/pivot/summary). config: { baseTableName, title, reportType, chartType?, axisColumns[], ... }. */
  createReport(workspaceId: string, config: Config) {
    return this.request("POST", `/workspaces/${enc(workspaceId)}/reports`, { config });
  }
  updateReport(workspaceId: string, reportId: string, config: Config) {
    return this.request("PUT", `/workspaces/${enc(workspaceId)}/reports/${enc(reportId)}`, { config });
  }

  // ============================ Modeling: columns ============================

  /** Add a column. config: { columnName, dataType, isPIIColumn?, geoRole? }. */
  addColumn(workspaceId: string, viewId: string, config: Config) {
    return this.request("POST", `/workspaces/${enc(workspaceId)}/views/${enc(viewId)}/columns`, { config });
  }
  renameColumn(workspaceId: string, viewId: string, columnId: string, config: Config) {
    return this.request("PUT", `/workspaces/${enc(workspaceId)}/views/${enc(viewId)}/columns/${enc(columnId)}`, { config });
  }
  deleteColumn(workspaceId: string, viewId: string, columnId: string, config?: Config) {
    return this.request("DELETE", `/workspaces/${enc(workspaceId)}/views/${enc(viewId)}/columns/${enc(columnId)}`, { config });
  }
  /** Hide columns. config: { columnIds: [...] }. */
  hideColumns(workspaceId: string, viewId: string, columnIds: string[]) {
    return this.request("PUT", `/workspaces/${enc(workspaceId)}/views/${enc(viewId)}/columns/hide`, { config: { columnIds } });
  }
  showColumns(workspaceId: string, viewId: string, columnIds: string[]) {
    return this.request("PUT", `/workspaces/${enc(workspaceId)}/views/${enc(viewId)}/columns/show`, { config: { columnIds } });
  }
  /** Reorder columns. `columns` must list ALL column ids in the desired order. */
  reorderColumns(workspaceId: string, viewId: string, columns: string[]) {
    return this.request("PUT", `/workspaces/${enc(workspaceId)}/views/${enc(viewId)}/columns/reorder`, { config: { columns } });
  }
  /** Add a lookup. config: { referenceViewId, referenceColumnId }. */
  addLookup(workspaceId: string, viewId: string, columnId: string, config: Config) {
    return this.request("POST", `/workspaces/${enc(workspaceId)}/views/${enc(viewId)}/columns/${enc(columnId)}/lookup`, { config });
  }
  removeLookup(workspaceId: string, viewId: string, columnId: string, config?: Config) {
    return this.request("DELETE", `/workspaces/${enc(workspaceId)}/views/${enc(viewId)}/columns/${enc(columnId)}/lookup`, { config });
  }

  // ============================ Modeling: formulas ============================

  /** Add an inline/custom formula column. config: { formulaName, expression, description? }. */
  addFormulaColumn(workspaceId: string, viewId: string, config: Config) {
    return this.request("POST", `/workspaces/${enc(workspaceId)}/views/${enc(viewId)}/customformulas`, { config });
  }
  deleteFormulaColumn(workspaceId: string, viewId: string, formulaId: string, config?: Config) {
    return this.request("DELETE", `/workspaces/${enc(workspaceId)}/views/${enc(viewId)}/customformulas/${enc(formulaId)}`, { config });
  }
  /** Add an aggregate formula. config: { formulaName, expression, description? }. */
  addAggregateFormula(workspaceId: string, viewId: string, config: Config) {
    return this.request("POST", `/workspaces/${enc(workspaceId)}/views/${enc(viewId)}/aggregateformulas`, { config });
  }
  deleteAggregateFormula(workspaceId: string, viewId: string, formulaId: string, config?: Config) {
    return this.request("DELETE", `/workspaces/${enc(workspaceId)}/views/${enc(viewId)}/aggregateformulas/${enc(formulaId)}`, { config });
  }

  // ============================ Modeling: folders ============================

  /** config: { folderName, folderDesc?, parentFolderId?, makeDefaultFolder? }. */
  createFolder(workspaceId: string, config: Config) {
    return this.request("POST", `/workspaces/${enc(workspaceId)}/folders`, { config });
  }
  renameFolder(workspaceId: string, folderId: string, config: Config) {
    return this.request("PUT", `/workspaces/${enc(workspaceId)}/folders/${enc(folderId)}`, { config });
  }
  deleteFolder(workspaceId: string, folderId: string, config?: Config) {
    return this.request("DELETE", `/workspaces/${enc(workspaceId)}/folders/${enc(folderId)}`, { config });
  }

  // ============================ Modeling: views ============================

  /** Rename a view. config: { viewName, viewDesc? }. */
  renameView(workspaceId: string, viewId: string, config: Config) {
    return this.request("PUT", `/workspaces/${enc(workspaceId)}/views/${enc(viewId)}`, { config });
  }
  /** Copy a view. config: { viewName, viewDesc?, copyWithData?, copyWithLookup?, folderId? }. */
  saveAsView(workspaceId: string, viewId: string, config: Config) {
    return this.request("POST", `/workspaces/${enc(workspaceId)}/views/${enc(viewId)}/saveas`, { config });
  }
  /** Move a view/table to trash (DELETE). config: { deleteDependentViews? }. */
  deleteView(workspaceId: string, viewId: string, config?: Config) {
    return this.request("DELETE", `/workspaces/${enc(workspaceId)}/views/${enc(viewId)}`, { config });
  }
  /** Move views into a folder. config: { folderId, viewIds: [...] }. */
  moveViewsToFolder(workspaceId: string, config: Config) {
    return this.request("PUT", `/workspaces/${enc(workspaceId)}/views/movetofolder`, { config });
  }
  /** Restore a view from trash. config: { withDependents? }. */
  restoreTrashView(workspaceId: string, viewId: string, config?: Config) {
    return this.request("POST", `/workspaces/${enc(workspaceId)}/trash/${enc(viewId)}`, { config });
  }
  /** Permanently delete a view from trash. config: { withDependents? }. */
  deleteTrashView(workspaceId: string, viewId: string, config?: Config) {
    return this.request("DELETE", `/workspaces/${enc(workspaceId)}/trash/${enc(viewId)}`, { config });
  }

  // ============================ Sharing API ============================

  /** config: { emailIds, viewIds, permissions:{read,...}, groupIds?, criteria?, inviteMail?, ... }. */
  shareViews(workspaceId: string, config: Config) {
    return this.request("POST", `/workspaces/${enc(workspaceId)}/views/share`, { config });
  }
  updateSharedViews(workspaceId: string, config: Config) {
    return this.request("PUT", `/workspaces/${enc(workspaceId)}/views/share`, { config });
  }
  /** config: { emailIds, viewIds?, removeAllViews?, groupIds? }. */
  removeShare(workspaceId: string, config: Config) {
    return this.request("DELETE", `/workspaces/${enc(workspaceId)}/views/share`, { config });
  }
  getSharedDetails(workspaceId: string, viewIds: string[]) {
    return this.request("GET", `/workspaces/${enc(workspaceId)}/share/shareddetails`, { config: { viewIds } });
  }
  getWorkspaceSharedDetails(workspaceId: string) {
    return this.request("GET", `/workspaces/${enc(workspaceId)}/share`);
  }
  getMyPermissions(workspaceId: string, viewId: string) {
    return this.request("GET", `/workspaces/${enc(workspaceId)}/views/${enc(viewId)}/share/mypermissions`);
  }
  getWorkspaceAdmins(workspaceId: string) {
    return this.request("GET", `/workspaces/${enc(workspaceId)}/admins`);
  }
  /** config: { emailIds, inviteMail? }. */
  addWorkspaceAdmins(workspaceId: string, config: Config) {
    return this.request("POST", `/workspaces/${enc(workspaceId)}/admins`, { config });
  }
  removeWorkspaceAdmins(workspaceId: string, config: Config) {
    return this.request("DELETE", `/workspaces/${enc(workspaceId)}/admins`, { config });
  }
  getOrgAdmins() {
    return this.request("GET", "/orgadmins");
  }
  getGroups(workspaceId: string) {
    return this.request("GET", `/workspaces/${enc(workspaceId)}/groups`);
  }
  /** config: { groupName, emailIds, groupDesc?, inviteMail? }. */
  createGroup(workspaceId: string, config: Config) {
    return this.request("POST", `/workspaces/${enc(workspaceId)}/groups`, { config });
  }
  getGroupDetails(workspaceId: string, groupId: string) {
    return this.request("GET", `/workspaces/${enc(workspaceId)}/groups/${enc(groupId)}`);
  }
  renameGroup(workspaceId: string, groupId: string, config: Config) {
    return this.request("PUT", `/workspaces/${enc(workspaceId)}/groups/${enc(groupId)}`, { config });
  }
  deleteGroup(workspaceId: string, groupId: string) {
    return this.request("DELETE", `/workspaces/${enc(workspaceId)}/groups/${enc(groupId)}`);
  }
  addGroupMembers(workspaceId: string, groupId: string, config: Config) {
    return this.request("POST", `/workspaces/${enc(workspaceId)}/groups/${enc(groupId)}/members`, { config });
  }
  removeGroupMembers(workspaceId: string, groupId: string, config: Config) {
    return this.request("DELETE", `/workspaces/${enc(workspaceId)}/groups/${enc(groupId)}/members`, { config });
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
    return this.request("GET", `/workspaces/${enc(workspaceId)}/users`);
  }
  addWorkspaceUsers(workspaceId: string, config: Config) {
    return this.request("POST", `/workspaces/${enc(workspaceId)}/users`, { config });
  }
  deleteWorkspaceUsers(workspaceId: string, config: Config) {
    return this.request("DELETE", `/workspaces/${enc(workspaceId)}/users`, { config });
  }
  /** config: { emailIds, operation (activate|deactivate) }. */
  changeWorkspaceUsersStatus(workspaceId: string, config: Config) {
    return this.request("PUT", `/workspaces/${enc(workspaceId)}/users/status`, { config });
  }
  /** config: { emailIds, role (USER|WORKSPACEADMIN|<custom>) }. */
  changeWorkspaceUsersRole(workspaceId: string, config: Config) {
    return this.request("PUT", `/workspaces/${enc(workspaceId)}/users/role`, { config });
  }

  // ============================ Embed / publish API ============================

  getViewUrl(workspaceId: string, viewId: string, config?: Config): Promise<unknown> {
    return this.request("GET", `/workspaces/${enc(workspaceId)}/views/${enc(viewId)}/publish`, { config });
  }
  getEmbedUrl(workspaceId: string, viewId: string, config?: Config) {
    return this.request("GET", `/workspaces/${enc(workspaceId)}/views/${enc(viewId)}/publish/embed`, { config });
  }
  getPrivateUrl(workspaceId: string, viewId: string, config?: Config) {
    return this.request("GET", `/workspaces/${enc(workspaceId)}/views/${enc(viewId)}/publish/privatelink`, { config });
  }
  createPrivateUrl(workspaceId: string, viewId: string, config?: Config) {
    return this.request("POST", `/workspaces/${enc(workspaceId)}/views/${enc(viewId)}/publish/privatelink`, { config });
  }
  removePrivateUrl(workspaceId: string, viewId: string) {
    return this.request("DELETE", `/workspaces/${enc(workspaceId)}/views/${enc(viewId)}/publish/privatelink`);
  }
  /** config: { publicPermLevel?, permissions?, criteria? }. */
  makeViewPublic(workspaceId: string, viewId: string, config?: Config) {
    return this.request("POST", `/workspaces/${enc(workspaceId)}/views/${enc(viewId)}/publish/public`, { config });
  }
  removePublic(workspaceId: string, viewId: string) {
    return this.request("DELETE", `/workspaces/${enc(workspaceId)}/views/${enc(viewId)}/publish/public`);
  }
  getPublishConfig(workspaceId: string, viewId: string) {
    return this.request("GET", `/workspaces/${enc(workspaceId)}/views/${enc(viewId)}/publish/config`);
  }
  updatePublishConfig(workspaceId: string, viewId: string, config: Config) {
    return this.request("PUT", `/workspaces/${enc(workspaceId)}/views/${enc(viewId)}/publish/config`, { config });
  }
  getSlideshows(workspaceId: string) {
    return this.request("GET", `/workspaces/${enc(workspaceId)}/slides`);
  }
  /** config: { slideName, viewIds, accessType? }. */
  createSlideshow(workspaceId: string, config: Config) {
    return this.request("POST", `/workspaces/${enc(workspaceId)}/slides`, { config });
  }
  getSlideshowDetails(workspaceId: string, slideId: string) {
    return this.request("GET", `/workspaces/${enc(workspaceId)}/slides/${enc(slideId)}`);
  }
  updateSlideshow(workspaceId: string, slideId: string, config: Config) {
    return this.request("PUT", `/workspaces/${enc(workspaceId)}/slides/${enc(slideId)}`, { config });
  }
  deleteSlideshow(workspaceId: string, slideId: string) {
    return this.request("DELETE", `/workspaces/${enc(workspaceId)}/slides/${enc(slideId)}`);
  }
  getSlideshowUrl(workspaceId: string, slideId: string, config?: Config) {
    return this.request("GET", `/workspaces/${enc(workspaceId)}/slides/${enc(slideId)}/publish`, { config });
  }

  // ============================ Variables ============================

  getVariables(workspaceId: string) {
    return this.request("GET", `/workspaces/${enc(workspaceId)}/variables`);
  }
  /** config: { variableName, variableType, variableDataType, defaultData?, ... }. */
  createVariable(workspaceId: string, config: Config) {
    return this.request("POST", `/workspaces/${enc(workspaceId)}/variables`, { config });
  }
  getVariableDetails(workspaceId: string, variableId: string) {
    return this.request("GET", `/workspaces/${enc(workspaceId)}/variables/${enc(variableId)}`);
  }
  updateVariable(workspaceId: string, variableId: string, config: Config) {
    return this.request("PUT", `/workspaces/${enc(workspaceId)}/variables/${enc(variableId)}`, { config });
  }
  deleteVariable(workspaceId: string, variableId: string) {
    return this.request("DELETE", `/workspaces/${enc(workspaceId)}/variables/${enc(variableId)}`);
  }

  // ============================ Synchronous & batch imports ============================

  private importForm(file: { content: string; name: string; type?: string }): FormData {
    const form = new FormData();
    form.append("FILE", new Blob([file.content], { type: file.type ?? "text/csv" }), file.name);
    return form;
  }
  /** Synchronous import into an EXISTING table (returns the import result inline, no job). */
  importDataSync(workspaceId: string, viewId: string, file: { content: string; name: string; type?: string }, config: Config) {
    return this.request("POST", `/workspaces/${enc(workspaceId)}/views/${enc(viewId)}/data`, { config, form: this.importForm(file) });
  }
  /** Synchronous import that CREATES a new table. config: { tableName, fileType, autoIdentify, ... }. */
  importDataSyncNewTable(workspaceId: string, file: { content: string; name: string; type?: string }, config: Config) {
    return this.request("POST", `/workspaces/${enc(workspaceId)}/data`, { config, form: this.importForm(file) });
  }
  /**
   * Batch import (chunked upload) into an existing table — async job.
   * batchKey/isLastBatch are MANDATORY in the batch protocol; default to a
   * single-batch upload ("start" + last). To continue a multi-batch upload,
   * override them in `config` (batchKey from the previous response, isLastBatch
   * "true" only on the final chunk).
   */
  createBatchImportJob(workspaceId: string, viewId: string, file: { content: string; name: string; type?: string }, config: Config) {
    return this.request("POST", `/bulk/workspaces/${enc(workspaceId)}/views/${enc(viewId)}/data/batch`, {
      config: { batchKey: "start", isLastBatch: "true", ...config },
      form: this.importForm(file),
    });
  }
  /** Batch import (chunked upload) creating a new table — async job. Same batchKey/isLastBatch semantics as above. */
  createBatchImportJobNewTable(workspaceId: string, file: { content: string; name: string; type?: string }, config: Config) {
    return this.request("POST", `/bulk/workspaces/${enc(workspaceId)}/data/batch`, {
      config: { batchKey: "start", isLastBatch: "true", ...config },
      form: this.importForm(file),
    });
  }

  // ============================ Metadata: dashboards / dependents / formulas (reads) ============================

  getOwnedDashboards() {
    return this.request("GET", "/dashboards/owned");
  }
  getSharedDashboards() {
    return this.request("GET", "/dashboards/shared");
  }
  getViewDependents(workspaceId: string, viewId: string) {
    return this.request("GET", `/workspaces/${enc(workspaceId)}/views/${enc(viewId)}/dependents`);
  }
  getColumnDependents(workspaceId: string, viewId: string, columnId: string) {
    return this.request("GET", `/workspaces/${enc(workspaceId)}/views/${enc(viewId)}/columns/${enc(columnId)}/dependents`);
  }
  getCustomFormulas(workspaceId: string, viewId: string) {
    return this.request("GET", `/workspaces/${enc(workspaceId)}/views/${enc(viewId)}/customformulas`);
  }
  getViewAggregateFormulas(workspaceId: string, viewId: string) {
    return this.request("GET", `/workspaces/${enc(workspaceId)}/views/${enc(viewId)}/aggregateformulas`);
  }
  getWorkspaceAggregateFormulas(workspaceId: string) {
    return this.request("GET", `/workspaces/${enc(workspaceId)}/aggregateformulas`);
  }
  getAggregateFormulaDependents(workspaceId: string, formulaId: string) {
    return this.request("GET", `/workspaces/${enc(workspaceId)}/aggregateformulas/${enc(formulaId)}/dependents`);
  }
  /** Evaluate an aggregate formula and return its current value. */
  getAggregateFormulaValue(workspaceId: string, formulaId: string) {
    return this.request("GET", `/workspaces/${enc(workspaceId)}/aggregateformulas/${enc(formulaId)}/value`);
  }
  getLastImportDetails(workspaceId: string, viewId: string) {
    return this.request("GET", `/workspaces/${enc(workspaceId)}/views/${enc(viewId)}/importdetails`);
  }
  /** Export selected views as a reusable template ZIP, returned base64-encoded. */
  exportAsTemplate(workspaceId: string, viewIds: string[]): Promise<string> {
    return this.requestRaw("GET", `/workspaces/${enc(workspaceId)}/template/data`, { config: { viewIds }, binary: true });
  }

  // ============================ Metadata: favorites / default / domain access ============================

  setFavoriteWorkspace(workspaceId: string, favorite: boolean) {
    return this.request(favorite ? "POST" : "DELETE", `/workspaces/${enc(workspaceId)}/favorite`);
  }
  setFavoriteView(workspaceId: string, viewId: string, favorite: boolean) {
    return this.request(favorite ? "POST" : "DELETE", `/workspaces/${enc(workspaceId)}/views/${enc(viewId)}/favorite`);
  }
  setDefaultWorkspace(workspaceId: string, isDefault: boolean) {
    return this.request(isDefault ? "POST" : "DELETE", `/workspaces/${enc(workspaceId)}/default`);
  }
  /** Enable/disable white-label (custom domain) access for a workspace. */
  setWorkspaceDomainAccess(workspaceId: string, enabled: boolean) {
    return this.request(enabled ? "POST" : "DELETE", `/workspaces/${enc(workspaceId)}/wlaccess`);
  }

  // ============================ Data sources & sync ============================

  /** Trigger a data sync for a datasource. (Plural "datasources" per Zoho's live docs + SDK; their OAS says singular.) */
  syncDatasource(workspaceId: string, datasourceId: string) {
    return this.request("POST", `/workspaces/${enc(workspaceId)}/datasources/${enc(datasourceId)}/sync`);
  }
  /** Update a datasource's connection config (opaque JSON per Zoho's spec). */
  updateDatasourceConnection(workspaceId: string, datasourceId: string, config: Config) {
    return this.request("PUT", `/workspaces/${enc(workspaceId)}/datasources/${enc(datasourceId)}`, { config });
  }
  /** Re-fetch a view's data from its source. */
  refetchViewData(workspaceId: string, viewId: string) {
    return this.request("POST", `/workspaces/${enc(workspaceId)}/views/${enc(viewId)}/sync`);
  }

  // ============================ Modeling: folders / formulas / analysis ============================

  makeDefaultFolder(workspaceId: string, folderId: string) {
    return this.request("POST", `/workspaces/${enc(workspaceId)}/folders/${enc(folderId)}/default`);
  }
  /** Change folder hierarchy. config: { hierarchy (0=parent, 1=child), parentFolderId? }. */
  moveFolder(workspaceId: string, folderId: string, config: Config) {
    return this.request("PUT", `/workspaces/${enc(workspaceId)}/folders/${enc(folderId)}/move`, { config });
  }
  /** Reposition a folder. config: { referenceFolderId }. */
  reorderFolder(workspaceId: string, folderId: string, config: Config) {
    return this.request("PUT", `/workspaces/${enc(workspaceId)}/folders/${enc(folderId)}/reorder`, { config });
  }
  /** Copy formula columns to a matching table elsewhere. config: { formulaColumnNames, destWorkspaceId, workspaceKey? }. destOrgId required. */
  copyFormulas(workspaceId: string, viewId: string, config: Config, destOrgId: string) {
    return this.request("POST", `/workspaces/${enc(workspaceId)}/views/${enc(viewId)}/formulas/copy`, {
      config,
      headers: { "ZANALYTICS-DEST-ORGID": destOrgId },
    });
  }
  /** Create views similar to a reference view. config: { referenceViewId, folderId, copyCustomFormula?, copyAggFormula? }. */
  createSimilarViews(workspaceId: string, viewId: string, config: Config) {
    return this.request("POST", `/workspaces/${enc(workspaceId)}/views/${enc(viewId)}/similarviews`, { config });
  }
  /** Auto-generate reports for a view. */
  autoAnalyseView(workspaceId: string, viewId: string) {
    return this.request("POST", `/workspaces/${enc(workspaceId)}/views/${enc(viewId)}/autoanalyse`);
  }
  /** Auto-generate reports for a single column. */
  autoAnalyseColumn(workspaceId: string, viewId: string, columnId: string) {
    return this.request("POST", `/workspaces/${enc(workspaceId)}/views/${enc(viewId)}/columns/${enc(columnId)}/autoanalyse`);
  }
  /** Edit a formula column. config: { expression, description? }. */
  editFormulaColumn(workspaceId: string, viewId: string, formulaId: string, config: Config) {
    return this.request("PUT", `/workspaces/${enc(workspaceId)}/views/${enc(viewId)}/customformulas/${enc(formulaId)}`, { config });
  }
  /** Edit an aggregate formula. config: { expression, description? }. */
  editAggregateFormula(workspaceId: string, viewId: string, formulaId: string, config: Config) {
    return this.request("PUT", `/workspaces/${enc(workspaceId)}/views/${enc(viewId)}/aggregateformulas/${enc(formulaId)}`, { config });
  }

  // ============================ Email schedules ============================

  getEmailSchedules(workspaceId: string) {
    return this.request("GET", `/workspaces/${enc(workspaceId)}/emailschedules`);
  }
  // Email-schedule paths are workspace-scoped per Zoho's live docs + SDK samples
  // (their OAS nests them under /views/{id} — the docs' curl samples win here).
  /** config: { scheduleName, viewIds, exportType, scheduleDetails:{calendarFrequency,hour,minute,...}, emailIds?, ... }. */
  createEmailSchedule(workspaceId: string, config: Config) {
    return this.request("POST", `/workspaces/${enc(workspaceId)}/emailschedules`, { config });
  }
  updateEmailSchedule(workspaceId: string, scheduleId: string, config: Config) {
    return this.request("PUT", `/workspaces/${enc(workspaceId)}/emailschedules/${enc(scheduleId)}`, { config });
  }
  deleteEmailSchedule(workspaceId: string, scheduleId: string) {
    return this.request("DELETE", `/workspaces/${enc(workspaceId)}/emailschedules/${enc(scheduleId)}`);
  }
  /** Send the scheduled email immediately (POST on the schedule resource — no /trigger suffix per the live docs). */
  triggerEmailSchedule(workspaceId: string, scheduleId: string) {
    return this.request("POST", `/workspaces/${enc(workspaceId)}/emailschedules/${enc(scheduleId)}`);
  }
  /** config: { operation: "activate" | "deactivate" }. */
  changeEmailScheduleStatus(workspaceId: string, scheduleId: string, config: Config) {
    return this.request("PUT", `/workspaces/${enc(workspaceId)}/emailschedules/${enc(scheduleId)}/status`, { config });
  }

  // ============================ AutoML ============================

  getAutoMLAnalysisOrg() {
    return this.request("GET", "/automl/analysis");
  }
  getAutoMLAnalysisInWorkspace(workspaceId: string) {
    return this.request("GET", `/automl/workspaces/${enc(workspaceId)}/analysis`);
  }
  getAutoMLAnalysisDetails(workspaceId: string, analysisId: string) {
    return this.request("GET", `/automl/workspaces/${enc(workspaceId)}/analysis/${enc(analysisId)}`);
  }
  getAutoMLModelDeployments(workspaceId: string, analysisId: string, modelId: string) {
    return this.request("GET", `/automl/workspaces/${enc(workspaceId)}/analysis/${enc(analysisId)}/models/${enc(modelId)}/deployments`);
  }
  /** config: { name, trainingTableId, predictionType (REGRESSION|CLASSIFICATION|CLUSTERING), features, serverOption, algorithms, targetColumn?, ... }. */
  createAutoMLAnalysis(workspaceId: string, config: Config) {
    return this.request("POST", `/automl/workspaces/${enc(workspaceId)}/analysis`, { config });
  }
  deleteAutoMLAnalysis(workspaceId: string, analysisId: string) {
    return this.request("DELETE", `/automl/workspaces/${enc(workspaceId)}/analysis/${enc(analysisId)}`);
  }
  deleteAutoMLModel(workspaceId: string, analysisId: string, modelId: string) {
    return this.request("DELETE", `/automl/workspaces/${enc(workspaceId)}/analysis/${enc(analysisId)}/models/${enc(modelId)}`);
  }
  /** config: { inputTableId, outputTable, scheduleDetails, outputColumns, predictionColumn, serverOption, importType, ... }. */
  createAutoMLDeployment(workspaceId: string, analysisId: string, modelId: string, config: Config) {
    return this.request("POST", `/automl/workspaces/${enc(workspaceId)}/analysis/${enc(analysisId)}/models/${enc(modelId)}/deployments`, { config });
  }
  deleteAutoMLDeployment(workspaceId: string, analysisId: string, deploymentId: string) {
    return this.request("DELETE", `/automl/workspaces/${enc(workspaceId)}/analysis/${enc(analysisId)}/deployments/${enc(deploymentId)}`);
  }
  /** Run a deployment now. */
  runAutoMLDeployment(workspaceId: string, analysisId: string, deploymentId: string) {
    return this.request("POST", `/automl/workspaces/${enc(workspaceId)}/analysis/${enc(analysisId)}/deployments/${enc(deploymentId)}/execute`);
  }
  /** What-if analysis. config: { features: { column: value, ... } }. */
  autoMLWhatIf(workspaceId: string, analysisId: string, modelId: string, config: Config) {
    return this.request("POST", `/automl/workspaces/${enc(workspaceId)}/analysis/${enc(analysisId)}/models/${enc(modelId)}/whatif`, { config });
  }
}
