/**
 * Stub for the `ai` (Vercel AI SDK) package.
 *
 * `ai` is an OPTIONAL peer dependency of `agents`, referenced only by its MCP
 * *client* helpers (via a lazy `import("ai")`). This server uses only the
 * McpAgent *server* path, so that code is never reached. We alias `ai` -> this
 * stub in wrangler.jsonc to keep the unused SDK out of the bundle.
 *
 * If you ever use agents' MCP-client features, `npm i ai@^5` and remove the
 * alias entry from wrangler.jsonc.
 */

export function jsonSchema(): never {
  throw new Error(
    "The 'ai' package is not bundled in this Worker (unused optional peer of `agents`). " +
      "Install `ai@^5` and remove the alias in wrangler.jsonc if you need it.",
  );
}
