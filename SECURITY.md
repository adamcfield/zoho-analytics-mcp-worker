# Security

## Reporting a vulnerability

Please **don't** open a public issue for security problems. Open a private
[GitHub security advisory](https://github.com/adamcfield/zoho-analytics-mcp-worker/security/advisories/new)
or contact the maintainer directly.

## Hardening built in

- **Auth-gated, fail-closed.** The bearer worker requires `Authorization: Bearer <MCP_AUTH_TOKEN>`
  (constant-time compare; if no token is configured, everything returns 401). The OAuth worker
  gates on OAuth 2.1 + a passphrase. The Zoho OAuth credentials never leave the Worker.
- **Tokens minted on demand.** The long-lived Zoho refresh token + client secret stay in Worker
  secrets; short-lived access tokens are fetched on demand and cached only in the Durable Object's
  memory. A 401 from Zoho triggers exactly one transparent refresh-and-retry.
- **Per-session isolation.** Each MCP session runs in its own Durable Object instance — server
  and transport objects are not shared across clients.
- **Safe by default.** Write/state-changing calls (add/update/delete row, import, create, delete
  view) are never auto-retried; only idempotent GETs retry, with `Retry-After`-aware backoff. Batch
  reads (`zoho_describe_workspace`) use bounded concurrency so they don't trip the per-minute
  frequency limiter. Mutating tools accept `dry_run`, and "update/delete all rows" requires an
  explicit `update_all_rows`/`delete_all_rows` flag rather than an empty criteria.
- **No secrets in the repo**; non-PII audit logging of state-changing calls (method + path only);
  optional `MCP_READONLY=true` mode that registers read tools only.

## Dependencies

The runtime stack is `agents@^0.14.5` + `@modelcontextprotocol/sdk@^1.29.0` + `zod@^4`, which
clears the earlier MCP SDK advisories (ReDoS, cross-client instance reuse, DNS-rebinding default).
`npm audit` reports **0 vulnerabilities**, verified in CI on every push/PR. `ai`/`react` are
required peers of `agents` but are not imported into the Worker bundle (`ai` is aliased to a stub).
