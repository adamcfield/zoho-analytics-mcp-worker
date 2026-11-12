import { defineConfig } from "vitest/config";

// The source uses NodeNext-style ".js" import specifiers that point at ".ts"
// files. Strip the extension during resolution so Vitest (Vite/esbuild) can
// resolve them to the TypeScript sources. `cloudflare:workers` (imported by
// @cloudflare/workers-oauth-provider at load) maps to a Node stub.
export default defineConfig({
  resolve: {
    alias: [
      { find: /^(\.{1,2}\/.*)\.js$/, replacement: "$1" },
      { find: "cloudflare:workers", replacement: new URL("./tests/stubs/cloudflare-workers.ts", import.meta.url).pathname },
    ],
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    server: { deps: { inline: ["@cloudflare/workers-oauth-provider"] } },
  },
});
