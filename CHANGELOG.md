# Changelog

## 1.0.0 — Initial release

The Zoho Analytics API v2 exposed as a remote MCP server on Cloudflare Workers,
in the same shape as the SignRequest MCP worker.

### Added
- **20 tools** across the Zoho Analytics surface:
  - *Discovery / metadata:* `zoho_whoami`, `zoho_get_orgs`, `zoho_list_workspaces`,
    `zoho_get_workspace_details`, `zoho_list_views`, `zoho_get_view_details`,
    `zoho_get_metadata`, `zoho_describe_workspace` (bounded-concurrency schema map).
  - *Read / query:* `zoho_export_data` (synchronous view export → parsed rows),
    `zoho_query_data` (**ad-hoc SQL** → async export job, polled to completion → rows),
    `zoho_create_export_job` / `zoho_get_export_job` (async export for large results),
    `zoho_get_import_job`.
  - *Writes (gated by `MCP_READONLY`):* `zoho_add_row`, `zoho_update_rows`, `zoho_delete_rows`,
    `zoho_import_data` (bulk CSV/JSON, waits for the job), `zoho_create_workspace`,
    `zoho_create_table`, `zoho_delete_view`.
- **OAuth 2.0 with auto-refresh.** The client holds a refresh token + client id/secret and mints
  short-lived access tokens itself (`Authorization: Zoho-oauthtoken …`), caching them and doing one
  transparent refresh-and-retry on a 401. A static `ZOHO_ACCESS_TOKEN` is also accepted for testing.
- **Multi-data-center.** `ZOHO_DC` selects `com | eu | in | au | jp | sa | ca | uk`; both the API
  and accounts (OAuth) domains are resolved per DC, with explicit base-URL overrides available.
- **Two deployments from one codebase:** a bearer-gated worker (`zoho-analytics-mcp`) and an
  OAuth-gated worker (`zoho-analytics-mcp-oauth`) for Claude.ai web custom connectors.
- **Resilience & safety:** the `CONFIG`-as-JSON request convention and `{status, summary, data}`
  envelope handled centrally; idempotent GET retry with `Retry-After`-aware backoff; writes never
  auto-retried; `dry_run` previews; explicit all-rows flags; non-PII audit logging; `mapLimit`
  bounded concurrency.
- **Quality:** vitest unit suite (OAuth refresh + 401 retry, DC routing, CONFIG/header encoding,
  envelope error handling, raw export, helpers) and GitHub Actions CI (typecheck + tests).
  `npm audit` clean; both workers bundle clean via `wrangler deploy --dry-run`.
