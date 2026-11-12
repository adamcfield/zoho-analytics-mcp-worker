# CLAUDE.md — Zoho Analytics MCP Worker

Guide for AI coding agents. This repo follows the fleet-wide MCP worker standard
(shape A: `McpAgent` + Durable Object); deviations need a reason in the PR.

## What this is
The Zoho Analytics REST API v2 (all 161 endpoints) as a remote MCP server on Cloudflare
Workers, 144 tools (51 read). Two deployments from one codebase:
- **Bearer worker** `zoho-analytics-mcp` — `src/index.ts`, `wrangler.jsonc`, gated by
  `MCP_AUTH_TOKEN` (constant-time). Optional R2 export spill (`EXPORTS`), Analytics Engine
  telemetry (`USAGE`), per-IP `RATE_LIMITER`, shared token cache `TOKEN_KV`.
- **OAuth worker** `zoho-analytics-mcp-oauth` — `src/oauth.ts`, `wrangler.oauth.jsonc`,
  `@cloudflare/workers-oauth-provider` for claude.ai. Single-user passphrase consent
  (`APP_PASSPHRASE`) by default; `ZOHO_MULTI_USER=true` = per-user Zoho login, refresh token
  in encrypted grant props. Uses `OAUTH_KV` for grants, token cache and schema cache.
  Bring-your-own client (`src/byo.ts`, on unless `MCP_BYO_KEYS="false"`): grant props
  `{zohoRefreshToken, cid, cs, dc, org}`; such a grant never uses the operator's `ZOHO_*`
  client, org, DC or base URLs.

## Layout
- `src/zohoanalytics.ts` — `ZohoAnalyticsClient`: DC routing (`DC_DOMAINS`), refresh-token
  minting + KV-shared access token (Zoho caps ~10 mints / 10 min per refresh token), GET-only
  retries on 429/5xx, writes never retried, signed download tokens, `constantTimeEqual`.
- `src/tools.ts` — every tool, registered via `readTool` / `writeTool` (`writeTool` is a no-op
  under `MCP_READONLY`), the `instrument` gate (MCP_CORE filter, per-call log, telemetry, rename
  aliases), `installListing` (our tools/list), `READ_VERBS`, `RENAMES`, `CORE_TOOLS`, resources
  and prompts.
- `src/version.ts` — `VERSION` + `MCP_INSTRUCTIONS`. `src/health.ts` — `/health` body.
- `tests/` — vitest, no network. `surface.test.ts` is the tool contract; `version.test.ts` the
  version mirror; `client.test.ts` / `helpers.test.ts` the client and helpers.
- `scripts/smoke.mjs` (post-deploy, `MCP_URL` + `MCP_TOKEN`), `scripts/live-test.mjs`
  (guarded live write-path test against a real org — creates and deletes a disposable table).

## Managed authorization (standard §3C)
- `src/managed-auth.ts` and `src/ui.ts` are fleet copies: never edit them here alone (only `BRAND` in ui.ts is ours). `/managed` lives in `src/managed.ts` (Node-testable, `tests/managed.test.ts`); a server-based Zoho sign-in for it comes back through `/zoho/callback` in `src/oauth.ts` (`parked.managed` → `finishManaged`). Grants carry `{user: "org-<slot>", zohoRefreshToken, cid, cs, dc, org, m: true}`; `slot` is shared by the whole org (one token cache). On only with `ZOHO_EMA_SECRET`; never rotate it.
- `src/oauth.ts` builds one provider per hostname with resource `<origin>/mcp`, the value existing grants carry: never change it. OAuth `/sse` was dropped in 1.9.0.

## Rules when adding or changing tools
- Name `zoho_<verb>_<noun>`. **`readOnlyHint: true` iff the verb is in `READ_VERBS`** — the
  Google Chat bot and other read-only consumers rely on both signals. Set all four annotations
  (spread `READ_ONLY` for reads). Read tools are never destructive.
- Renaming: add `old: new` to `RENAMES`; never just rename. The old name stays callable and
  hidden until `ALIAS_REMOVAL_VERSION`.
- Destructive tools take `dry_run`; "all rows" operations need an explicit flag.
- Adding a tool changes the counts pinned in `tests/surface.test.ts` (full / readonly / core).
  Update README's tool tables too.
- zod v4 only.

## Versioning (enforced by tests/version.test.ts)
Bump with `npm version <v> --no-git-tag-version`, update `VERSION` in `src/version.ts`, and add
a `## <v> — …` entry at the top of `CHANGELOG.md`, all in the same commit.

## Workflows
- `npm run typecheck && npm test` before every commit; CI also runs
  `npx wrangler deploy --dry-run` for both configs (an import that resolves in tsc can still
  fail to bundle — that is how the agents 0.30 peer issue showed up).
- `npm run dev` needs `.dev.vars` (copy `.dev.vars.example`). `wrangler dev` + `npm run smoke`
  with `MCP_URL=http://127.0.0.1:8787/mcp` exercises the real workerd path.
- Deploy: `deploy.yml` (workflow_dispatch, bearer|oauth) or `npm run deploy` /
  `npm run deploy:oauth`. Merging and deploying are handled by the project's DevOps thread.

## Gotchas
- `agents` ≥ 0.30 imports `@modelcontextprotocol/server` / `client` (SDK v2 packages) as
  required peers; they are explicit dependencies here. `agents` 0.31+ moves `McpAgent` to the v2
  SDK API — that upgrade is a real migration, not a bump.
- npm 10.9 hits `Cannot read properties of null (reading 'edgesOut')` on this lockfile —
  regenerate with `npx npm@11 install`. Never commit a `--legacy-peer-deps` lock (drops peers,
  breaks the bundle while typecheck stays green).
- `@cloudflare/workers-oauth-provider` is 1.2.4 (pinned). 1.x audience-binds tokens to
  `resourceMetadata.resource`; it stays `<origin>/mcp` (what 0.7.2 issued grants for).
- Zoho's live API returns view types as name strings ("Table"), not the documented numeric
  codes — use `isTabularViewType` / `readableViewType`.
- `tools/list` is ours (`installListing`): it must run after all tools are registered and must
  stay byte-identical to the SDK's listing (test). Never touch SDK private fields.
- Workers: store `fetch.bind(globalThis)`; bare `fetch` on an object throws "Illegal invocation".
