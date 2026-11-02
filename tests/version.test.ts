/** Version mirror (standard §9.1): VERSION == package.json == package-lock.json == top CHANGELOG entry. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { VERSION, MCP_INSTRUCTIONS } from "../src/version.js";
import { healthBody } from "../src/health.js";

// vitest runs from the repo root.
const read = (p: string) => readFileSync(p, "utf8");

describe("version", () => {
  it("matches package.json and package-lock.json", () => {
    expect(JSON.parse(read("package.json")).version).toBe(VERSION);
    const lock = JSON.parse(read("package-lock.json"));
    expect(lock.version).toBe(VERSION);
    expect(lock.packages[""].version).toBe(VERSION);
  });
  it("matches the top CHANGELOG.md entry", () => {
    const top = /^## (\d+\.\d+\.\d+)/m.exec(read("CHANGELOG.md"));
    expect(top?.[1]).toBe(VERSION);
  });
  it("keeps server instructions under 900 chars", () => {
    expect(MCP_INSTRUCTIONS.length).toBeLessThanOrEqual(900);
  });
});

describe("health", () => {
  const configured = { ZOHO_CLIENT_ID: "id", ZOHO_CLIENT_SECRET: "s3cret", ZOHO_REFRESH_TOKEN: "r3fresh", ZOHO_ORG_ID: "1" };
  it("is ok with no warnings when fully configured, and reports the version", () => {
    const h = healthBody(configured, "bearer");
    expect(h).toMatchObject({ ok: true, version: VERSION, warnings: [] });
  });
  it("warns on missing creds, unknown DC and mistyped flags, never echoing secrets", () => {
    const h = healthBody({ ZOHO_CLIENT_SECRET: "s3cret", ZOHO_DC: "mars", MCP_READONLY: "yes" }, "bearer");
    expect(h.ok).toBe(false);
    const w = (h.warnings as string[]).join(" | ");
    expect(w).toMatch(/credentials not set/);
    expect(w).toMatch(/ZOHO_ORG_ID/);
    expect(w).toMatch(/mars/);
    expect(w).toMatch(/MCP_READONLY/);
    expect(JSON.stringify(h)).not.toContain("s3cret");
  });
  it("multi-user mode only needs the app credentials", () => {
    const h = healthBody({ ZOHO_CLIENT_ID: "id", ZOHO_CLIENT_SECRET: "x", ZOHO_ORG_ID: "1" }, "oauth", [], { perUserZoho: true });
    expect(h.ok).toBe(true);
  });
});
