import { defineConfig } from "vitest/config";

// The source uses NodeNext-style ".js" import specifiers that point at ".ts"
// files. Strip the extension during resolution so Vitest (Vite/esbuild) can
// resolve them to the TypeScript sources.
export default defineConfig({
  resolve: {
    alias: [{ find: /^(\.{1,2}\/.*)\.js$/, replacement: "$1" }],
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
