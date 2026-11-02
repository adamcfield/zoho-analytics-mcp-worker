/**
 * Tool-surface contract: names, annotations (MCP worker standard §4.3), the
 * MCP_READONLY / MCP_CORE gates, hidden rename aliases, and tools/list bytes.
 * In-memory MCP client <-> server, no network (no tool is actually invoked
 * against Zoho; alias calls fail schema validation before any fetch).
 */
import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTools, READ_VERBS, RENAMES, type RegisterToolsOptions } from "../src/tools.js";
import { ZohoAnalyticsClient } from "../src/zohoanalytics.js";

const noFetch = (async () => {
  throw new Error("network disabled in tests");
}) as unknown as typeof fetch;

async function connect(opts: RegisterToolsOptions = {}) {
  const server = new McpServer({ name: "zoho-analytics", version: "test" });
  registerTools(server, new ZohoAnalyticsClient({ accessToken: "test", fetch: noFetch } as never), opts);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const verbOf = (name: string) => name.replace(/^zoho_/, "").split("_")[0];

describe("tool surface", async () => {
  const full = (await (await connect()).listTools()).tools;
  const readOnly = (await (await connect({ readOnly: true })).listTools()).tools;
  const core = (await (await connect({ core: true })).listTools()).tools;

  it("has the expected tool counts per mode", () => {
    expect(full.length).toBe(144);
    expect(readOnly.length).toBe(51);
    expect(core.length).toBe(26);
  });

  it("names every tool zoho_<verb>_<noun>, snake_case, <= 64 chars, unique", () => {
    const names = full.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) {
      expect(n, n).toMatch(/^zoho_[a-z0-9]+(_[a-z0-9]+)*$/);
      expect(n.length, n).toBeLessThanOrEqual(64);
    }
  });

  it("sets all four annotations on every tool", () => {
    for (const t of full) {
      for (const k of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const) {
        expect(typeof t.annotations?.[k], `${t.name}.${k}`).toBe("boolean");
      }
    }
  });

  it("readOnlyHint is true exactly when the verb is a read verb (§4.3)", () => {
    const reads = new Set<string>(READ_VERBS);
    for (const t of full) {
      expect(t.annotations?.readOnlyHint, `${t.name} (verb "${verbOf(t.name)}")`).toBe(reads.has(verbOf(t.name)));
    }
  });

  it("read tools are never destructive", () => {
    for (const t of full.filter((t) => t.annotations?.readOnlyHint)) expect(t.annotations?.destructiveHint, t.name).toBe(false);
  });

  it("MCP_READONLY registers exactly the read-only tools", () => {
    expect(readOnly.map((t) => t.name).sort()).toEqual(full.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name).sort());
  });

  it("MCP_CORE is a subset of the full surface", () => {
    const all = new Set(full.map((t) => t.name));
    for (const t of core) expect(all.has(t.name), t.name).toBe(true);
  });
});

describe("rename aliases", () => {
  it("every rename target exists and no old name is reused", async () => {
    const names = new Set((await (await connect()).listTools()).tools.map((t) => t.name));
    for (const [old, target] of Object.entries(RENAMES)) {
      expect(names.has(target), target).toBe(true);
      expect(names.has(old), old).toBe(false); // hidden from tools/list
    }
  });

  it("old names stay callable (reach the tool's schema validation, not 'not found')", async () => {
    const client = await connect();
    for (const old of Object.keys(RENAMES)) {
      const res = (await client.callTool({ name: old, arguments: {} })) as { isError?: boolean; content: { text: string }[] };
      expect(res.isError, old).toBe(true);
      expect(res.content[0].text, old).not.toMatch(/not found/i);
      expect(res.content[0].text, old).toMatch(/validation|invalid|required/i);
    }
  });

  it("aliases follow their target's gates (MCP_CORE drops an alias with its target)", async () => {
    const client = await connect({ core: true });
    const res = (await client.callTool({ name: "zoho_automl_whatif", arguments: {} })) as { isError?: boolean; content: { text: string }[] };
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/not found/i);
  });

  it("custom tools/list is byte-identical to the SDK's native listing minus aliases", async () => {
    const ours = (await (await connect()).listTools()).tools;
    const native = (await (await connect({ hideAliases: false })).listTools()).tools.filter((t) => !(t.name in RENAMES));
    expect(JSON.stringify(ours)).toBe(JSON.stringify(native));
  });
});
