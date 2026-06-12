# Changelog

## 1.5.2 — Final sweep (dry: 3 nits, zero behavioral findings)

The final full-coverage sweep confirmed zero critical/major/minor findings — only 3 cosmetic
nits, all fixed: empty-array spreads in the sharing tools now use the `.length` convention
uniformly (and the shared email schema requires at least one address); the share-paths
regression test also asserts HTTP verbs; the README enumerations include all 144 tools
(zoho_get_query_table, zoho_rename_group, zoho_get_slideshow, zoho_get_variable were missing
from their category lists). The sweep independently re-verified: 144 tools (51 read / 93
write), 59/59 tests, 161/161 spec endpoints covered, version consistency.

## 1.5.1 — Sweep round 3 (2 confirmed findings fixed)

Round 3 of the repetitive sweep came back nearly dry: 2 confirmed findings, both fixed.

### Fixed
- **Deploy workflow could never deploy:** deploy.yml pinned Node 20, but wrangler 4.x's CLI
  hard-exits below Node 22 — every dispatched deploy failed at the deploy step while CI stayed
  green (nothing in CI invokes wrangler). Both workflows now pin Node 22.
- **`zoho_remove_share`:** an explicitly-empty `view_ids: []` bypassed the round-2 exclusivity
  guard and was forwarded alongside `removeAllViews: true` as the exact ambiguous dual-key payload
  the guard exists to prevent. Empty arrays are now rejected up front, and the spread only includes
  non-empty lists.

## 1.5.0 — Sweep round 2 (18 confirmed findings fixed)

Second sweep round: 18 confirmed (vs 29 in round 1 — converging), all fixed.

### Live-docs path corrections (OAS disagreed again)
- **Sharing:** share/remove-share are `POST|DELETE /workspaces/{id}/share` (not `/views/share`);
  the update is per-view `PUT /workspaces/{id}/views/{view-id}/share` — `zoho_update_shared_views`
  now takes a required `view_id`.
- **Datasources:** `GET /workspaces/{id}/datasources` is workspace-scoped — `zoho_list_datasources`
  no longer takes a view_id.

### Token-flow concurrency (introduced by the round-1 self-heal)
- The refresh now returns a `{token, expiry}` snapshot so a concurrent 401 can't poison the KV
  entry with `expiry: 0`; a late 401 only clears the cache if it still holds the rejected token;
  and an acquire that re-adopted the just-rejected token runs one more mint.

### Reliability / safety
- Export-job creation (a state-creating GET) is never auto-retried (could create duplicate jobs);
  `exportAsTemplate` got the Content-Length precheck; `adv()` flipped to options-FIRST everywhere
  (passthroughs can no longer override audited/validated keys on share/email-schedule/table-from-
  data); `zoho_remove_share` rejects view_ids + remove_all_views together; cascade flags now echo
  in dry_run/audit on delete_column/delete_folder/delete_trash_view; `zoho_sort_data` reset no
  longer demands fake columns; `zoho_get_shared_details` rejects an explicit empty view_ids;
  consent-page base64 encode is chunked (oversized unicode `state` no longer 500s);
  `zoho_list_workspaces` scope=owned/shared now parses the correct response shape (was returning
  empty lists).
- Export tools gained the `options` passthrough (delimiter, showHiddenCols, ...). The
  Content-Length test now proves the body is never read; **59 tests**.

## 1.4.0 — Sweep round 1 (29 confirmed findings fixed)

First round of the repetitive full-coverage sweep (7 inspectors over every file, each finding
adversarially verified): 29 confirmed, 2 rejected. All fixed.

### Fixed (functional / reliability)
- **Poisoned-token self-heal:** on a 401, the retry no longer re-adopts the same dead token from
  the shared KV store — it bypasses the store, mints fresh, and overwrites the poisoned entry
  (was: up to ~59 min of unrecoverable failures; a regression introduced by the v1.3.0 KV cache).
- **Timeout now covers the body read** (was disarmed at headers-received, so a stalled body hung
  unbounded) in both core() and the token refresh; a throwing TokenStore.set no longer fails a
  request whose token was already minted.
- **Live-docs path corrections:** makeDefaultFolder is PUT (not POST); sortData uses the standard
  CONFIG form transport (not a raw JSON body) and takes column IDS (tool description fixed).
- **Oversized responses refused via Content-Length before the body is read** (10MB) on sync
  export + bulk download, complementing the post-read guard; guard message no longer recommends
  nonexistent download paging.
- Key regeneration GET is never auto-retried (a retry could rotate twice); negative Retry-After
  clamped; requestRaw stringifies structured errorMessage; zero-row JSON downloads no longer
  misreported as CSV.

### Safety / security
- `zoho_import_data` options can no longer override the validated importType (merge order);
  `zoho_delete_rows` rejects criteria + delete_all_rows together; dry_run + audit added to the
  three cascade-delete tools (formula/aggregate/lookup with deleteDependentViews) and audit to
  the privilege-granting tools (add admins/users, role changes).
- OAuth worker: consent round-trip is UTF-8-safe (btoa threw a 500 on a unicode OAuth state);
  IPv6 lockout buckets by /64 (per-address buckets were trivially bypassable); bearer scheme
  match is case-insensitive per RFC 7235.

### Completeness (140 → 144 tools: 51 read / 93 write)
- New: `zoho_get_query_table` (read SQL before editing), `zoho_rename_group`,
  `zoho_get_slideshow`, `zoho_get_variable`.
- Extended: `zoho_list_workspaces` scope (owned/shared), `zoho_get_shared_details` workspace-wide
  when view_ids omitted, `zoho_list_views` pagination (start_index/no_of_result),
  `zoho_update_report` axis_columns now required (per spec).
- CI validates the smoke script (`node --check`); README/docs corrected (headline scoped to the
  client, deploy.yml documented); **56 tests**.

## 1.3.0 — Production hardening (second adversarial review + live verification)

A 4-dimension adversarial review (v1.2.0 diff, production ops, security, MCP-consumer quality)
confirmed 24 issues; all fixed. The worker was also booted and verified live for the first time
(MCP handshake, 140 tools listed, graceful credential errors, MCP_READONLY = exactly 48 reads).

### Fixed (functional)
- **Batch imports work now:** the mandatory `batchKey`/`isLastBatch` CONFIG keys are sent
  (single-batch defaults, caller-overridable for multi-batch chains).
- **Email-schedule writes use the live-docs paths** (workspace-scoped, no `/views/{id}` segment,
  trigger = POST on the schedule with no `/trigger` suffix) — Zoho's OAS disagrees with their own
  docs + SDK here; the docs win. `view_id` removed from those 5 tools (it was also undiscoverable).
- **Datasource sync/update use plural `datasources`** per live docs + SDK (OAS says singular).
- **AutoML table ids are passed as strings** — `Number()` silently corrupted Zoho's 18-19 digit
  ids (beyond `MAX_SAFE_INTEGER`).
- **Binary template export detects failure envelopes** (a body starting `{` is decoded as JSON,
  not returned as a fake ZIP).

### Security
- **Credentials out of URLs:** the OAuth token refresh sends refresh_token/client_secret in the
  POST body, never the query string (query strings are logged by intermediaries).
- **Path-injection closed:** all ~137 caller-supplied ids are `encodeURIComponent`-ed before path
  interpolation.
- **Passphrase brute-force lockout** on the OAuth worker: 10 failed attempts per IP → 429 for
  15 minutes (KV-backed).

### Production operations
- **Cross-session access-token cache:** new `TokenStore` (KV-backed) shares one Zoho access token
  across all MCP sessions — without it, each session-DO minted its own token against Zoho's
  ~10-per-10-min cap. The OAuth worker uses `OAUTH_KV` automatically; the bearer worker takes an
  optional `TOKEN_KV` binding (documented in wrangler.jsonc/README).
- **Memory/context bounds:** sync exports/downloads refused over ~10MB, imports over ~25MB,
  template ZIPs over ~256KB — each with actionable guidance. Large tool results are emitted as
  compact JSON (pretty-printing doubled the token cost of row exports).
- **Retry-After capped at 8s** so a 429 inside a polling loop can't sleep past the caller's
  deadline. Audit lines added to the remaining privilege-sensitive writes (role changes, share
  updates, domain access, datasource connection, email schedules, private URLs).
- **Gated deploy workflow** (.github/workflows/deploy.yml): manual dispatch → typecheck + tests →
  wrangler deploy → live smoke test.

### MCP-consumer quality
- zoho_get_view_metadata vs zoho_get_view_details disambiguated (metadata = column ids for the
  column tools); read-tool descriptions that reference write tools now note those are absent on
  read-only deploys; stale smoke-test comment fixed.
- **50 tests** (path encoding, batch CONFIG, schedule paths, token store hit/write-back,
  no-secrets-in-URL).

## 1.2.0 — 100% endpoint coverage (161/161)

A spec-diff audit (every `(method, path)` pair in Zoho's seven official OpenAPI files vs. the
client) found 52 unimplemented endpoints; all are now covered — coverage is **161/161**.

### Added
- **AutoML** (12 endpoints / 10 tools): list/get analyses, create analysis (train
  REGRESSION/CLASSIFICATION/CLUSTERING models), model deployments (create/list/run/delete),
  what-if predictions, deletes with `dry_run`.
- **Email schedules** (6/6): list, create, update, delete, trigger-now (`dry_run`),
  activate/deactivate.
- **Sync & batch imports** (4): `mode: async | sync | batch` on `zoho_import_data` and
  `zoho_create_table_from_data` (synchronous inline import and chunked batch jobs).
- **Dependents & formula reads** (8): view/column dependents, custom & aggregate formula lists,
  aggregate formula value + dependents, last-import details.
- **Formula/view modeling** (6): edit formula column, edit aggregate formula, copy formulas
  cross-workspace/org, create similar views, auto-analyse view/column.
- **Folder placement** (3): make default, change hierarchy, reorder.
- **Favorites & workspace flags** (8): favorite workspace/view, default workspace, white-label
  domain access (each a single set-style tool).
- **Data sources** (3): sync datasource, update connection config, refetch view data.
- **Template export** (1): `zoho_export_workspace_template` — binary ZIP returned base64
  (new binary read path in the client).
- **Dashboards** scope param (owned/shared/all → 2 endpoints).
- 4 new tests (sync-import path, base64 template export, POST/DELETE favorite toggle, AutoML
  paths) — **44 total**.

Tool surface: **140 tools** (48 read / 92 write).

## 1.1.1 — Hardening pass (adversarial review)

A multi-agent review against Zoho's docs/OpenAPI specs surfaced 18 confirmed issues; all fixed.

### Fixed
- **Bulk job failures detected.** `JOB_CODE` now models `1003` (ERROR OCCURRED): the polling loops
  in `zoho_query_data` / `zoho_import_data` stop and raise with the server's error details instead
  of reporting a failed job as "still running" until timeout; `zoho_get_export_job` returns a
  `failed` flag. (Previously a failed job burned the full poll window, then advised more polling.)
- **`MCP_READONLY` no longer leaks a write path.** Secret-key rotation moved out of the read tool:
  `zoho_get_workspace_secret_key` is now strictly read-only and a new gated
  `zoho_regenerate_workspace_secret_key` (destructive, `dry_run`) does the rotation.
- **OAuth refresh hardened.** Concurrent callers now share a single in-flight refresh
  (single-flight) instead of stampeding the token endpoint on a cold isolate, and a throttled
  (HTTP 429) refresh is retried instead of failing immediately.
- **`zoho_update_rows`** rejects `criteria` + `update_all_rows` together (previously forwarded
  both, risking an all-rows update when Zoho gives the flag precedence).
- **CN data center** added (`analyticsapi.zoho.com.cn` / `accounts.zoho.com.cn`).
- **`zoho_add_column`** accepts `DURATION` (its description promised it; the enum rejected it).
- **`zoho_delete_view`** description corrected: it moves the view to trash (restorable), not a
  permanent delete.
- **Smoke test** auto-detects read-only deployments and skips write-tool checks (previously could
  never pass against `MCP_READONLY=true`).
- **Docs corrected:** secret-key tool placement, audit-trail description (action-level lines log
  resource names/counts, not just method+path), `dry_run` scope (destructive tools, not all
  writes), `ai`/`react` peer-dependency status.

### Removed
- The inert `ai`-stub alias (`src/ai-stub.ts`): the bundle is byte-identical without it, its
  rationale was wrong for `agents@0.14` (no lazy `import("ai")`), and `ai` is installed anyway as
  a required peer.

### Changed
- Test files are now typechecked (`tsconfig.json` includes `tests/`); fetch mocks properly typed.
- **40 tests** (new: single-flight refresh, 401-retry asserts the fresh token, DELETE-with-CONFIG
  form body, raw-export HTTP error, `{data:{rows}}` parse variant).

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
