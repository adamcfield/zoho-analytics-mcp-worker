# zoho-analytics-mcp-worker

The [Zoho Analytics](https://www.zoho.com/analytics/) [API v2](https://www.zoho.com/analytics/api/v2/introduction.html) exposed as a **remote [MCP](https://modelcontextprotocol.io) server**, running as a **Cloudflare Worker** (Streamable HTTP + SSE). Built on the [`agents`](https://github.com/cloudflare/agents) `McpAgent`.

Its client implements **ALL 161 endpoints of the Zoho Analytics v2 API** (verified against Zoho's [official OpenAPI specs](https://github.com/zoho/analytics-oas)), exposed through **144 tools** — discovery & metadata, the Data API, the sync/async/batch Bulk API, modeling (tables, query tables, reports, columns, lookups, formulas, folders, view lifecycle, dependents), workspace administration, sharing & collaboration (groups, admins), user management, publishing & embedding (URLs, slideshows), email schedules, variables, favorites, data-source sync, template export, and **AutoML** — plus conveniences the raw API lacks: a one-call **workspace schema map**, an end-to-end **SQL-query helper** that drives the async export job for you, bounded-concurrency batch reads, bounded job polling, and `dry_run` previews on destructive operations. The tool definitions live in [`src/tools.ts`](src/tools.ts) and the Zoho Analytics REST client in [`src/zohoanalytics.ts`](src/zohoanalytics.ts); both are transport-agnostic, so every build shares an identical tool surface. Set `MCP_READONLY=true` to register only the ~51 read tools.

This repo ships **two deployments from the same code**:

| Worker | Auth | Use it from | Entry |
|--------|------|-------------|-------|
| **`zoho-analytics-mcp`** | static bearer token | Claude Code, Claude Desktop, programmatic | [`src/index.ts`](src/index.ts) · [`wrangler.jsonc`](wrangler.jsonc) |
| **`zoho-analytics-mcp-oauth`** | OAuth 2.1 (single-user passphrase) | **Claude.ai web** custom connector | [`src/oauth.ts`](src/oauth.ts) · [`wrangler.oauth.jsonc`](wrangler.oauth.jsonc) |

> **Status:** both deployments typecheck, bundle, and pass tests clean (`npm audit` = 0 vulnerabilities). Secrets are set via `wrangler secret put` and are **never** committed.

---

## Contents

- [Architecture](#architecture)
- [Endpoints](#endpoints)
- [Authentication](#authentication)
- [Tools](#tools)
- [Zoho Analytics API coverage](#zoho-analytics-api-coverage)
- [Configuration](#configuration)
- [Getting Zoho OAuth credentials](#getting-zoho-oauth-credentials)
- [Deploy](#deploy)
- [Verify](#verify)
- [Testing](#testing)
- [Connect a client](#connect-a-client) — [Claude Code](#claude-code) · [Claude Desktop](#claude-desktop) · [Claude Web](#claude-web) · [Programmatic](#programmatic)
- [OAuth worker (Claude.ai web)](#oauth-worker-claudeai-web)
- [Caveats](#caveats)
- [Project layout](#project-layout)

---

## Architecture

```
client                         bearer worker (src/index.ts)
Claude Code / Desktop / curl ── Authorization: Bearer <MCP_AUTH_TOKEN> ──┐
                                                                          │
Claude.ai web ── OAuth 2.1 (passphrase) ── oauth worker (src/oauth.ts) ──┤
                                                                          ▼
                                              ZohoAnalyticsMCP (McpAgent, Durable Object)
                                                • registerTools(server, client)  ← tools.ts
                                                • ZohoAnalyticsClient             ← zohoanalytics.ts
                                                                          │
                              mints access tokens from a refresh token (accounts.zoho.*),
                              then  Authorization: Zoho-oauthtoken <access_token>
                                    ZANALYTICS-ORGID: <org id>
                                                                          ▼
                                                  Zoho Analytics REST API v2
```

- **`McpAgent` + Durable Object.** MCP session state lives in a Cloudflare Durable Object (SQLite-backed, migration `v1`). Both workers bind it as `MCP_OBJECT` → class `ZohoAnalyticsMCP`.
- **Shared tool layer.** `registerTools()` and `ZohoAnalyticsClient` are plain TypeScript with no Worker-specific imports, so the bearer worker and the OAuth worker share them.
- **OAuth token management.** Zoho access tokens expire hourly, so the client stores the refresh token + client id/secret and mints/caches access tokens itself, with a transparent refresh-and-retry on `401`.
- **Lean bundle.** Only the `agents/mcp` server path is imported; the `ai`/`react` peer dependencies of `agents` are never reached by the bundle.

---

## Endpoints

Bearer worker (`zoho-analytics-mcp`):

| Method | Path           | Auth   | Purpose                                  |
|--------|----------------|--------|------------------------------------------|
| `GET`  | `/`            | none   | Health check → `zoho-analytics-mcp worker: ok` |
| `POST` | `/mcp`         | Bearer | MCP Streamable HTTP (modern clients)     |
| `GET`  | `/sse`         | Bearer | MCP SSE (legacy clients)                 |

OAuth worker (`zoho-analytics-mcp-oauth`) — see [OAuth worker](#oauth-worker-claudeai-web).

---

## Authentication

Two layers, kept separate:

1. **Connector auth — who may call this MCP server.**
   - **Bearer worker** is gated by a **shared bearer token** (`MCP_AUTH_TOKEN`): fails closed (no secret → everything 401s), constant-time comparison. Right for programmatic use, `mcp-remote`, Claude Code/Desktop.
   - **OAuth worker** implements **OAuth 2.1** (PKCE + dynamic client registration) via [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider), gated by a single shared **passphrase** (`APP_PASSPHRASE`) on the consent screen — the only model Claude.ai web accepts.

2. **Zoho auth — how the server calls Zoho Analytics.** The server holds your Zoho **refresh token** + **client id/secret** (`ZOHO_*` secrets) and mints short-lived access tokens at the matching accounts domain (`accounts.zoho.<dc>/oauth/v2/token`), sending them as `Authorization: Zoho-oauthtoken <token>` along with the `ZANALYTICS-ORGID` header. Tokens are cached in memory and refreshed automatically; a `401` triggers one transparent refresh-and-retry. See [Getting Zoho OAuth credentials](#getting-zoho-oauth-credentials).

**Data centers.** Set `ZOHO_DC` to the data center your Zoho account lives in. Both the API host and the OAuth host are resolved from it:

| `ZOHO_DC` | API host | Accounts (OAuth) host |
|-----------|----------|------------------------|
| `com` (default) | `analyticsapi.zoho.com` | `accounts.zoho.com` |
| `eu` | `analyticsapi.zoho.eu` | `accounts.zoho.eu` |
| `in` | `analyticsapi.zoho.in` | `accounts.zoho.in` |
| `au` | `analyticsapi.zoho.com.au` | `accounts.zoho.com.au` |
| `jp` | `analyticsapi.zoho.jp` | `accounts.zoho.jp` |
| `sa` | `analyticsapi.zoho.sa` | `accounts.zoho.sa` |
| `ca` | `analyticsapi.zohocloud.ca` | `accounts.zohocloud.ca` |
| `uk` | `analyticsapi.zoho.uk` | `accounts.zoho.uk` |
| `cn` | `analyticsapi.zoho.com.cn` | `accounts.zoho.com.cn` |

---

## Tools

All tools call an external service (`openWorldHint: true`). IDs (`workspace_id`, `view_id`) come from the discovery tools. Filters use Zoho's `criteria` syntax — fully-qualified, double-quoted identifiers with single-quoted values, e.g. `"Sales"."Region"='East'`.

### Discovery & metadata (read-only)

| Tool | Purpose | Input |
|------|---------|-------|
| `zoho_whoami` | Health check — confirms the OAuth credentials work; lists accessible orgs; echoes the configured org id + data center | — |
| `zoho_get_orgs` | List the organizations the token can access (find your org id) | — |
| `zoho_list_workspaces` | List workspaces (owned + shared); compact id/name by default | `verbose?` |
| `zoho_get_workspace_details` | Details of one workspace | `workspace_id` |
| `zoho_list_views` | List views (tables, query tables, charts, pivots, dashboards) in a workspace; filter by type/keyword | `workspace_id`, `view_types?`, `keyword?`, `verbose?` |
| `zoho_get_view_details` | Details of one view; includes column metadata by default | `view_id`, `with_columns?` |
| `zoho_get_metadata` | Look up workspace/view + columns **by name** instead of id | `workspace_name`, `view_name?` |
| `zoho_describe_workspace` | **Schema map** — lists views and fetches each table's columns (bounded concurrency) so you can understand a workspace before querying | `workspace_id`, `include_columns?`, `max_views?`, `concurrency?` |

### Read & query

| Tool | Purpose | Input | Class |
|------|---------|-------|-------|
| `zoho_query_data` | **The headline tool** — run an ad-hoc SQL `SELECT`. Creates an async bulk export job from your SQL, polls it to completion, downloads & parses the rows | `workspace_id`, `sql_query`, `max_rows?`, `timeout_seconds?` | read-only |
| `zoho_export_data` | Synchronously export a table/view's rows (optionally filtered/projected) as parsed rows | `workspace_id`, `view_id`, `criteria?`, `selected_columns?`, `response_format?`, `max_rows?` | read-only |
| `zoho_create_export_job` | Start an **async** export (by SQL or by view) for large results; returns a `job_id` | `workspace_id`, `sql_query?`/`view_id?`, `response_format?`, `criteria?` | read-only · not idempotent |
| `zoho_get_export_job` | Check an export job (`1001`/`1002` running · `1003` **failed** · `1004` done · `1005` invalid) and optionally download its data | `workspace_id`, `job_id`, `download?`, `max_rows?` | read-only |
| `zoho_get_import_job` | Check an import job's status + summary | `workspace_id`, `job_id` | read-only |

> **Sync vs. async export.** `zoho_export_data` is synchronous and convenient, but Zoho disallows it for views over 1,000,000 rows, live-connect workspaces, and Dashboard/Query-Table views. For those — and for ad-hoc SQL — use `zoho_query_data` (waits inline) or `zoho_create_export_job` + `zoho_get_export_job` (for results too big to wait on).

### Writes (gated by `MCP_READONLY`)

When `MCP_READONLY=true`, none of these are registered — they never even appear in `tools/list`.

| Tool | Purpose | Input | Class |
|------|---------|-------|-------|
| `zoho_add_row` | Add one row to a table | `workspace_id`, `view_id`, `columns`, `date_format?`, `dry_run?` | write |
| `zoho_update_rows` | Update rows matching `criteria` (or all rows with explicit `update_all_rows`); `add_if_not_exist` upserts | `workspace_id`, `view_id`, `columns`, `criteria?`, `update_all_rows?`, `add_if_not_exist?`, `dry_run?` | **destructive** |
| `zoho_delete_rows` | Delete rows matching `criteria` (or all rows with explicit `delete_all_rows`) | `workspace_id`, `view_id`, `criteria?`, `delete_all_rows?`, `dry_run?` | **destructive** |
| `zoho_import_data` | Bulk-import CSV/JSON text into a table: `append` / `truncateadd` (replace) / `updateadd` (upsert). Waits for the job by default | `workspace_id`, `view_id`, `data`, `file_type?`, `import_type?`, `matching_columns?`, `auto_identify?`, `on_error?`, `wait?`, `dry_run?` | **destructive** |
| `zoho_create_workspace` | Create a new workspace (database) | `workspace_name`, `workspace_desc?` | write |
| `zoho_create_table` | Create a table with a column design (typed columns) | `workspace_id`, `table_name`, `columns[]`, `description?`, `folder_name?`, `dry_run?` | write |
| `zoho_delete_view` | Move a view/table to the **trash** (restore with `zoho_restore_view`; erase permanently with `zoho_delete_trash_view`) | `workspace_id`, `view_id`, `dry_run?` | **destructive** |

**Safety:** the destructive tools (delete row/column/folder/view/workspace, remove share/users, etc.) accept `dry_run` to preview without changing anything. "Update/delete all rows" requires an explicit `update_all_rows`/`delete_all_rows` flag — an empty criteria is rejected. `truncateadd` imports warn that they replace all data. Write calls are **never** auto-retried.

### Modeling & schema (writes)

Build and reshape data models. Query tables: `zoho_get_query_table`, `zoho_create_query_table`, `zoho_edit_query_table`. Reports: `zoho_create_report`, `zoho_update_report`. Columns: `zoho_add_column`, `zoho_rename_column`, `zoho_delete_column`, `zoho_hide_columns`, `zoho_show_columns`, `zoho_reorder_columns`, `zoho_add_lookup`, `zoho_remove_lookup`. Formulas: `zoho_add_formula_column`, `zoho_delete_formula_column`, `zoho_add_aggregate_formula`, `zoho_delete_aggregate_formula`. Folders: `zoho_create_folder`, `zoho_rename_folder`, `zoho_delete_folder`. View lifecycle: `zoho_rename_view`, `zoho_save_as_view`, `zoho_move_views_to_folder`, `zoho_sort_data`, `zoho_create_table_from_data`, and trash ops `zoho_get_trash` · `zoho_restore_view` · `zoho_delete_trash_view`. Workspace admin: `zoho_rename_workspace`, `zoho_delete_workspace`, `zoho_copy_workspace`, `zoho_copy_views`, `zoho_regenerate_workspace_secret_key` (rotates/invalidates the key). Plus reads `zoho_get_workspace_secret_key`, `zoho_list_folders`, `zoho_get_view_metadata`, `zoho_list_dashboards`, `zoho_list_recent_views`, `zoho_list_datasources`.

### Sharing & collaboration

`zoho_share_views`, `zoho_update_shared_views`, `zoho_remove_share`, `zoho_get_shared_details`, `zoho_get_my_permissions`. Groups: `zoho_list_groups`, `zoho_create_group`, `zoho_rename_group`, `zoho_delete_group`, `zoho_add_group_members`, `zoho_remove_group_members`. Admins: `zoho_get_workspace_admins`, `zoho_add_workspace_admins`, `zoho_remove_workspace_admins`, `zoho_get_org_admins`. Permissions are a boolean map (`read` required; also `export`, `vud`, `addRow`, `drillDown`, `share`, …).

### User management

Org: `zoho_list_users`, `zoho_add_users`, `zoho_remove_users`, `zoho_set_users_status`, `zoho_change_user_role` (USER/VIEWER/ORGADMIN), plus `zoho_get_subscription` and `zoho_get_resources`. Workspace: `zoho_list_workspace_users`, `zoho_add_workspace_users`, `zoho_remove_workspace_users`, `zoho_change_workspace_user_status`, `zoho_change_workspace_user_role` (USER/WORKSPACEADMIN/custom).

### Publishing & embedding

`zoho_get_view_url`, `zoho_get_embed_url`, `zoho_get_private_url`, `zoho_create_private_url`, `zoho_remove_private_url`, `zoho_make_view_public`, `zoho_remove_public`, `zoho_get_publish_config`, `zoho_update_publish_config`. Slideshows: `zoho_list_slideshows`, `zoho_get_slideshow`, `zoho_create_slideshow`, `zoho_update_slideshow`, `zoho_delete_slideshow`, `zoho_get_slideshow_url`.

### Variables

`zoho_list_variables`, `zoho_get_variable`, `zoho_create_variable`, `zoho_update_variable`, `zoho_delete_variable`.

### Dependents, formulas & analysis

Reads: `zoho_get_dependents` (view/column), `zoho_list_formula_columns`, `zoho_list_aggregate_formulas`, `zoho_get_aggregate_formula_value`, `zoho_get_aggregate_formula_dependents`, `zoho_get_last_import_details`, `zoho_export_workspace_template` (base64 ZIP). Writes: `zoho_edit_formula_column`, `zoho_edit_aggregate_formula`, `zoho_copy_formulas` (cross-workspace/org), `zoho_create_similar_views`, `zoho_auto_analyse` (view or column), folder placement (`zoho_make_default_folder`, `zoho_move_folder`, `zoho_reorder_folder`).

### Favorites, defaults & data sources

`zoho_set_favorite_workspace`, `zoho_set_favorite_view`, `zoho_set_default_workspace`, `zoho_set_workspace_domain_access` (white-label), `zoho_sync_datasource`, `zoho_update_datasource_connection`, `zoho_refetch_view_data`.

### Email schedules

`zoho_list_email_schedules`, `zoho_create_email_schedule`, `zoho_update_email_schedule`, `zoho_delete_email_schedule`, `zoho_trigger_email_schedule` (sends real email; `dry_run`), `zoho_set_email_schedule_status`.

### AutoML

Reads: `zoho_list_automl_analysis` (org/workspace), `zoho_get_automl_analysis`, `zoho_list_automl_deployments`, `zoho_automl_whatif` (prediction for one input). Writes: `zoho_create_automl_analysis` (train models — REGRESSION/CLASSIFICATION/CLUSTERING), `zoho_create_automl_deployment`, `zoho_run_automl_deployment`, and deletes for analysis/model/deployment (all with `dry_run`).

### Operational modes

- **Read-only deploys.** Set `MCP_READONLY=true` for a reporting/dashboard connector — only the discovery, query, and read tools are registered.
- **Audit trail.** Every state-changing call is logged at the HTTP layer (`[zoho-analytics-mcp] POST /workspaces/.../rows` — method + path), and write tools add an action-level audit line with resource names/counts (workspace/table/column names, email counts — never row data or email addresses), visible via `wrangler tail`.
- **Resilience.** Idempotent GETs retry on `429`/`5xx` with `Retry-After`-aware backoff; writes never auto-retry; batch reads use bounded concurrency to respect Zoho's per-minute frequency limits.

---

## Zoho Analytics API coverage

The tools map onto these Zoho Analytics v2 endpoints (relative to `https://<api-host>/restapi/v2`). Operation options ride in the `CONFIG` query parameter (a URL-encoded JSON object); responses use the `{status, summary, data}` envelope, except the export/download endpoints which stream raw file bytes.

| Tool | Method & path |
|------|---------------|
| `zoho_get_orgs` / `zoho_whoami` | `GET /orgs` |
| `zoho_list_workspaces` | `GET /workspaces` |
| `zoho_get_workspace_details` | `GET /workspaces/{workspace-id}` |
| `zoho_list_views` | `GET /workspaces/{workspace-id}/views` |
| `zoho_get_view_details` / `zoho_describe_workspace` | `GET /views/{view-id}` (`withInvolvedMetaInfo`) |
| `zoho_get_metadata` | `GET /metadetails` |
| `zoho_export_data` | `GET /workspaces/{workspace-id}/views/{view-id}/data` |
| `zoho_add_row` | `POST /workspaces/{workspace-id}/views/{view-id}/rows` |
| `zoho_update_rows` | `PUT /workspaces/{workspace-id}/views/{view-id}/rows` |
| `zoho_delete_rows` | `DELETE /workspaces/{workspace-id}/views/{view-id}/rows` |
| `zoho_query_data` / `zoho_create_export_job` (SQL) | `GET /bulk/workspaces/{workspace-id}/data` (`sqlQuery`) |
| `zoho_create_export_job` (view) | `GET /bulk/workspaces/{workspace-id}/views/{view-id}/data` |
| `zoho_get_export_job` | `GET /bulk/workspaces/{workspace-id}/exportjobs/{job-id}` (+ `/data` to download) |
| `zoho_import_data` | `POST /bulk/workspaces/{workspace-id}/views/{view-id}/data` (multipart `FILE`) |
| `zoho_get_import_job` | `GET /bulk/workspaces/{workspace-id}/importjobs/{job-id}` |
| `zoho_create_workspace` | `POST /workspaces` |
| `zoho_create_table` | `POST /workspaces/{workspace-id}/tables` |
| `zoho_delete_view` | `DELETE /workspaces/{workspace-id}/views/{view-id}` |

The table above lists the core data/metadata endpoints; the rest of the v2 surface is covered too — modeling (`/querytables`, `/reports`, `/views/{id}/columns`, `/customformulas`, `/aggregateformulas`, `/folders`, `/views/{id}/saveas`, `/trash/{id}`, `/similarviews`, `/autoanalyse`, …), workspace admin (`/secretkey`, copy/rename/delete, `/views/copy`, `/template/data`, favorites/default/`/wlaccess`), sharing (`/share`, per-view `/views/{id}/share` updates, `/groups`, `/admins`, `/orgadmins`), user management (`/users`, `/users/role`, `/subscription`, `/resources`, `/workspaces/{id}/users`), publishing/embed (`/publish`, `/publish/embed`, `/publish/privatelink`, `/publish/public`, `/slides`), email schedules (`/emailschedules` CRUD + trigger), data sources (`/datasources`, `/datasource/{id}/sync`), `/variables`, and AutoML (`/automl/...` analysis, models, deployments, what-if) — see the matching tool categories above and the `ZohoAnalyticsClient` methods in [`src/zohoanalytics.ts`](src/zohoanalytics.ts).

**Coverage: 161/161 endpoints** across Zoho's seven published OpenAPI spec files (data, bulk, metadata, modeling, share, user-management, embed), verified by diffing every spec `(method, path)` pair against the client. Full API: <https://www.zoho.com/analytics/api/v2/introduction.html> · specs: <https://github.com/zoho/analytics-oas>.

---

## Configuration

Set via `npx wrangler secret put <NAME>` (secrets) or a `[vars]` block (non-secret). Add `-c wrangler.oauth.jsonc` to target the OAuth worker.

| Name | Worker | Required | Purpose |
|------|--------|----------|---------|
| `ZOHO_CLIENT_ID` | both | ✅ | Zoho OAuth client id |
| `ZOHO_CLIENT_SECRET` | both | ✅ | Zoho OAuth client secret (may be per-DC) |
| `ZOHO_REFRESH_TOKEN` | both | ✅ | Long-lived refresh token (`access_type=offline`) |
| `ZOHO_ORG_ID` | both | ✅ | `ZANALYTICS-ORGID` — get it from `zoho_get_orgs` |
| `MCP_AUTH_TOKEN` | bearer | ✅ | Shared bearer clients send as `Authorization: Bearer <…>` |
| `APP_PASSPHRASE` | oauth | ✅ | Passphrase entered on the OAuth consent screen |
| `OAUTH_KV` (binding) | oauth | ✅ | KV namespace storing OAuth grants/registrations |
| `ZOHO_DC` | both | optional | Data center: `com` (default) `eu in au jp sa ca uk cn` |
| `TOKEN_KV` (binding) | bearer | recommended | KV namespace sharing ONE Zoho access token across all sessions (the OAuth worker reuses `OAUTH_KV` for this automatically). Without it, every new MCP session mints its own token — Zoho caps token creation at ~10 per 10 min per refresh token, so >10 new sessions in 10 minutes will start failing auth. `npx wrangler kv namespace create TOKEN_KV`, then uncomment the block in [wrangler.jsonc](wrangler.jsonc). |
| `ZOHO_ACCESS_TOKEN` | both | optional | Static access token (expires hourly; testing only — skips refresh) |
| `ZOHO_ANALYTICS_BASE_URL` | both | optional | Override the API host |
| `ZOHO_ACCOUNTS_BASE_URL` | both | optional | Override the accounts/OAuth host |
| `ZOHO_MAX_RETRIES` | both | optional | Max retries for idempotent calls (default `3`) |
| `MCP_READONLY` | both | optional | `true` ⇒ register read tools only |

---

## Getting Zoho OAuth credentials

One-time setup to produce `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, and `ZOHO_REFRESH_TOKEN`. Do this on the **API console of your data center** (e.g. `api-console.zoho.eu` for EU).

1. **Register a client** at <https://api-console.zoho.com/> → **Self Client** (simplest for a single-user server) or a Server-based app. Note the **Client ID** and **Client Secret**.
2. **Pick scopes.** For the full tool surface use `ZohoAnalytics.fullaccess.all`, or scope down to:
   `ZohoAnalytics.data.all,ZohoAnalytics.metadata.read,ZohoAnalytics.modeling.all` (drop `data.create/update/delete` and `modeling.all` for a read-only connector).
3. **Generate a grant token (code)** with `access_type=offline` (Self Client: "Generate Code"; or run the `/oauth/v2/auth` consent flow with `response_type=code&access_type=offline`).
4. **Exchange the code for a refresh token** (once) at your accounts domain:
   ```bash
   curl -X POST "https://accounts.zoho.com/oauth/v2/token" \
     -d "grant_type=authorization_code" \
     -d "client_id=$ZOHO_CLIENT_ID" \
     -d "client_secret=$ZOHO_CLIENT_SECRET" \
     -d "code=<grant_token>"
   # → { "access_token": "...", "refresh_token": "...", "expires_in": 3600 }
   ```
   Save the `refresh_token` — that's `ZOHO_REFRESH_TOKEN`. (The server refreshes access tokens from it automatically; the refresh token itself doesn't expire unless revoked.)
5. **Find your org id** after deploying by calling the `zoho_get_orgs` / `zoho_whoami` tool, and set it as `ZOHO_ORG_ID`.

---

## Deploy

```bash
npm install

# Zoho credentials — paste each value at the prompt (do NOT put secrets on the command line):
npx wrangler secret put ZOHO_CLIENT_ID
npx wrangler secret put ZOHO_CLIENT_SECRET
npx wrangler secret put ZOHO_REFRESH_TOKEN
npx wrangler secret put ZOHO_ORG_ID
npx wrangler secret put MCP_AUTH_TOKEN

# Non-secret data center (if not 'com'): add to wrangler.jsonc as  "vars": { "ZOHO_DC": "eu" }
npx wrangler deploy
```

Generate a strong `MCP_AUTH_TOKEN` without a trailing newline (a stray newline breaks the constant-time compare):

```bash
MCP_TOKEN=$(openssl rand -hex 32); printf '%s' "$MCP_TOKEN" | npx wrangler secret put MCP_AUTH_TOKEN; echo "MCP_AUTH_TOKEN=$MCP_TOKEN"
```

The first deploy creates the Durable Object (migration `v1`) and prints your `https://zoho-analytics-mcp.<subdomain>.workers.dev` URL. For the OAuth worker, see [OAuth worker](#oauth-worker-claudeai-web).

---

## Verify

```bash
URL="https://zoho-analytics-mcp.<subdomain>.workers.dev"

# 1) Health (no auth) → "zoho-analytics-mcp worker: ok"
curl "$URL/"

# 2) Fail-closed — no token → 401
curl -i -X POST "$URL/mcp"

# 3) MCP initialize (with token) → JSON-RPC result, not 401
curl -X POST "$URL/mcp" \
  -H "Authorization: Bearer <MCP_AUTH_TOKEN>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```

Or run the end-to-end smoke test (initialize → tools/list → `zoho_whoami`, which validates the Zoho credentials live):

```bash
MCP_URL="$URL/mcp" MCP_TOKEN="<MCP_AUTH_TOKEN>" npm run smoke
```

---

## Testing

```bash
npm run typecheck   # tsc --noEmit (strict)
npm test            # vitest — OAuth refresh + 401 retry, DC routing, CONFIG/header encoding, envelope errors, raw export, helpers
npm run smoke       # live smoke vs a deployed worker (set MCP_URL + MCP_TOKEN)
```

CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs typecheck + tests on every push and PR. The client is fully unit-testable with a mocked `fetch` (injectable `backoffBaseMs` keeps retry tests fast); the pure helpers (row parsing, column extraction, view-type mapping) are tested against fixtures.

---

## Connect a client

### Claude Code

```bash
claude mcp add --transport http --scope user zoho-analytics \
  https://zoho-analytics-mcp.<subdomain>.workers.dev/mcp \
  --header "Authorization: Bearer <MCP_AUTH_TOKEN>"

claude mcp list   # → zoho-analytics: … (HTTP) - ✓ Connected
```

### Claude Desktop

Claude Desktop speaks stdio, so bridge the remote server with [`mcp-remote`](https://www.npmjs.com/package/mcp-remote). Add to `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`) and fully restart the app:

```jsonc
{
  "mcpServers": {
    "zoho-analytics": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://zoho-analytics-mcp.<subdomain>.workers.dev/mcp",
        "--header", "Authorization: Bearer <MCP_AUTH_TOKEN>"
      ]
    }
  }
}
```

> If a bare `npx` doesn't resolve inside the Desktop app (common when Node is installed via a version manager), use the absolute path from `which npx`.

### Claude Web

The **bearer** worker can't be added to Claude.ai web (its connector UI requires OAuth, with no field for a static token). Use the **`zoho-analytics-mcp-oauth`** deployment instead:

1. Deploy it and set its secrets — see [OAuth worker](#oauth-worker-claudeai-web).
2. In Claude.ai → **Settings → Connectors → Add custom connector**, enter the MCP URL:
   `https://zoho-analytics-mcp-oauth.<subdomain>.workers.dev/mcp`
3. Claude.ai discovers OAuth automatically (dynamic client registration) and sends you to the consent screen. Enter your **passphrase** to authorize.

### Programmatic

Any HTTP MCP client works — send `Authorization: Bearer <MCP_AUTH_TOKEN>` and `Accept: application/json, text/event-stream` to `POST /mcp`.

---

## OAuth worker (Claude.ai web)

`zoho-analytics-mcp-oauth` is the same MCP server fronted by an OAuth 2.1 provider, gated by a single shared passphrase. Routes:

| Route | Purpose |
|-------|---------|
| `GET /` | health check (no auth) |
| `GET`/`POST` `/authorize` | passphrase consent screen |
| `/token`, `/register`, `/.well-known/oauth-*` | OAuth endpoints (handled by the provider) |
| `POST /mcp`, `GET /sse` | MCP transports, OAuth-protected |

Deploy alongside the bearer worker:

```bash
# One-time: create the KV namespace the provider needs, then paste its id into wrangler.oauth.jsonc
npx wrangler kv namespace create OAUTH_KV   # → { "binding": "OAUTH_KV", "id": "<paste into kv_namespaces>" }

# Secrets (paste at the prompt; -c selects the OAuth worker):
npx wrangler secret put ZOHO_CLIENT_ID     -c wrangler.oauth.jsonc
npx wrangler secret put ZOHO_CLIENT_SECRET -c wrangler.oauth.jsonc
npx wrangler secret put ZOHO_REFRESH_TOKEN -c wrangler.oauth.jsonc
npx wrangler secret put ZOHO_ORG_ID        -c wrangler.oauth.jsonc
npx wrangler secret put APP_PASSPHRASE     -c wrangler.oauth.jsonc

npx wrangler deploy -c wrangler.oauth.jsonc
```

`APP_PASSPHRASE` fails closed — if unset, the consent screen rejects every attempt. Then add the connector in Claude.ai per [Claude Web](#claude-web).

---

## Caveats

- **Bring your own OAuth app.** You need a registered Zoho client and a refresh token (see [Getting Zoho OAuth credentials](#getting-zoho-oauth-credentials)). `ZOHO_DC` must match the data center your account lives in, or token refresh fails.
- **Ad-hoc SQL is async.** Zoho runs ad-hoc SQL through a bulk export *job*. `zoho_query_data` hides this (create → poll → download) but bounds its wait (default 30s, cap 60s); for very large result sets it returns a `job_id` to poll with `zoho_get_export_job`.
- **API units & frequency limits.** Calls consume daily API units and are subject to per-minute frequency limits (≈100 req/min overall). Batch tools use bounded concurrency, but heavy use can still hit quota errors (`6043`/`6044`/`6045`).
- **Large tool surface.** Full coverage means ~144 tools. That's a lot for one connector — if your client struggles with the count or you only need reporting, deploy with `MCP_READONLY=true` for the ~51 read tools. Advanced/long-tail CONFIG keys on the modeling, sharing, publish, and variable tools are passed through an `options` object (documented per tool) rather than enumerated as parameters.
- **Single-user OAuth.** The OAuth worker gates on one shared passphrase — fine for a personal connector, not multi-tenant. Swap the consent handler for a real IdP if you need per-user identity.
- **Spec ambiguities.** A number of Zoho endpoints are inconsistent between their OpenAPI specs and their live API docs/SDK. Where they conflict, this client follows the **live docs + SDK**: email-schedule writes are workspace-scoped with no `/trigger` suffix; datasource paths are workspace-scoped and plural; share/remove-share are `/workspaces/{id}/share` with a per-view PUT for updates; `makeDefaultFolder` is PUT; `sortData` uses the CONFIG transport with column IDs. Remaining unverified niche path: `get_my_permissions` (`mypermissions` per OAS vs `userpermissions` per SDK). Verify niche endpoints with a live call.
- **Memory bounds.** Sync exports/downloads are refused above ~10MB (use the async CSV export and page it), imports above ~25MB (split the file), and template ZIPs above ~256KB (export fewer views) — Durable Objects have a 128MB memory ceiling and tool results land in an LLM context.
- **Dependency versions.** `agents@^0.14.5` + `@modelcontextprotocol/sdk@^1.29.0` + `zod@^4`; `npm audit` is clean. `ai`/`react` are required peers of `agents` (npm auto-installs them) but nothing on the `agents/mcp` server path imports them, so they never enter the Worker bundle.

---

## Project layout

```
src/
  index.ts          Bearer worker entry — routing, bearer gate, McpAgent/Durable Object, clientFromEnv
  oauth.ts          OAuth worker entry — OAuthProvider + passphrase consent + McpAgent
  tools.ts          registerTools() — 100+ tool definitions + Zod schemas + helpers (shared)
  zohoanalytics.ts  ZohoAnalyticsClient — dependency-free REST client (fetch-only): OAuth refresh,
                    CONFIG-param + envelope handling, DC routing, retry/backoff, mapLimit (shared)
tests/              vitest unit tests (client OAuth/retry/DC/CONFIG, helpers)
vitest.config.ts    test config (resolves NodeNext .js specifiers to .ts)
scripts/smoke.mjs   smoke test against a deployed worker (npm run smoke)
.github/workflows/ci.yml      CI — typecheck + tests + smoke-script syntax check on push/PR
.github/workflows/deploy.yml  gated manual deploy (typecheck + tests -> wrangler deploy -> live smoke); needs CLOUDFLARE_API_TOKEN secret
wrangler.jsonc        bearer worker config (zoho-analytics-mcp)
wrangler.oauth.jsonc  OAuth worker config (zoho-analytics-mcp-oauth) — adds OAUTH_KV
package.json          deps (SDK ^1.29.0, agents ^0.14.5, zod ^4, workers-oauth-provider, wrangler, vitest)
```
