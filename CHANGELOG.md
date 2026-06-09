# Changelog

## 1.1.0 — Full API coverage

### Added
- Expanded from 20 to **~101 tools**, covering the full Zoho Analytics v2 surface:
  - **Modeling:** query tables (`create`/`edit`), reports (`create`/`update`), columns
    (`add`/`rename`/`delete`/`hide`/`show`/`reorder`/`lookup`), inline & aggregate formulas,
    folders (`create`/`rename`/`delete`), view lifecycle (`rename`/`save_as`/`move`/`sort`,
    trash `list`/`restore`/`delete`), `create_table_from_data`.
  - **Workspace admin:** `rename`/`delete`/`copy` workspace, `copy_views`, `get_workspace_secret_key`
    (incl. cross-org via `ZANALYTICS-DEST-ORGID`).
  - **Sharing:** share/update/remove view shares, shared-details, my-permissions, groups CRUD +
    members, workspace & org admins.
  - **User management:** org users (add/remove/status/role, subscription, resources) and
    workspace users (add/remove/status/role).
  - **Publishing & embed:** view/embed/private URLs, make-public, publish config, slideshows CRUD.
  - **Variables:** list/create/update/delete.
  - **Reads:** folders, dashboards, recent views, view metadata, datasources, trash.

### Changed
- **Transport fix:** write calls (POST/PUT/DELETE) now send `CONFIG` as an
  `application/x-www-form-urlencoded` body (matching Zoho's documented `--data-urlencode`),
  while GET and multipart import keep `CONFIG` in the query string. Empty `204 No Content`
  responses are surfaced as `{status:"success"}`. Added support for cross-org `ZANALYTICS-DEST-ORGID`
  headers and a raw-JSON-body path (sort).
- Tool count check in `npm run smoke` raised; new transport unit tests (CONFIG-in-body, 204,
  cross-org header, multipart) added — **36 tests** total, typecheck clean, both workers bundle clean.

### Notes
- AutoML and email-schedule APIs remain intentionally unexposed.
- Advanced/long-tail CONFIG keys on modeling/sharing/publish/variable tools are passed through an
  `options` object rather than enumerated as parameters.

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
