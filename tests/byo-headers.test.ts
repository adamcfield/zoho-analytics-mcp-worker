import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { credentialId, maskClientId, readHeaderCredential, sameCredential } from "../src/byo-headers.js";
import { healthBody } from "../src/health.js";

// Bring-your-own Zoho client in X-Zoho-* headers on the bearer worker (standard §3A, gateway §13.9).

const h = (o: Record<string, string>) => new Headers(o);
const full = {
  "X-Zoho-Client-Id": "1000.ABCDEF123456",
  "X-Zoho-Client-Secret": "secret",
  "X-Zoho-Refresh-Token": "1000.refresh.token",
};

describe("readHeaderCredential", () => {
  it("returns null when no Zoho header is present (bearer gate applies)", () => {
    expect(readHeaderCredential(h({ authorization: "Bearer x" }), {})).toBeNull();
  });

  it("reads client, refresh token, default DC com, optional org", () => {
    expect(readHeaderCredential(h(full), {})).toEqual({
      ok: true,
      cred: { cid: "1000.ABCDEF123456", cs: "secret", rt: "1000.refresh.token", dc: "com" },
    });
    expect(readHeaderCredential(h({ ...full, "X-Zoho-DC": "EU", "X-Zoho-Org-Id": "123456" }), {})).toEqual({
      ok: true,
      cred: { cid: "1000.ABCDEF123456", cs: "secret", rt: "1000.refresh.token", dc: "eu", org: "123456" },
    });
  });

  it("needs all three of client id, secret and refresh token", () => {
    const r = readHeaderCredential(h({ "X-Zoho-Client-Id": "a", "X-Zoho-Refresh-Token": "b" }), {});
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toContain("X-Zoho-Client-Secret");
  });

  it("refuses an unknown DC, a non-numeric org and control characters", () => {
    expect(readHeaderCredential(h({ ...full, "X-Zoho-DC": "mars" }), {})).toMatchObject({ ok: false });
    expect(readHeaderCredential(h({ ...full, "X-Zoho-Org-Id": "abc" }), {})).toMatchObject({ ok: false });
    expect(readHeaderCredential(h({ ...full, "X-Zoho-Client-Secret": "a b" }), {})).toMatchObject({ ok: false });
  });

  it("MCP_BYO_KEYS=false refuses header credentials instead of falling through to the worker's own", () => {
    expect(readHeaderCredential(h(full), { MCP_BYO_KEYS: "false" })).toMatchObject({ ok: false });
  });

  it("never echoes a value in an error", () => {
    const r = readHeaderCredential(h({ ...full, "X-Zoho-DC": "secretvalue" }), {}) as { error: string };
    expect(r.error).not.toContain("secretvalue");
  });
});

describe("credential helpers", () => {
  it("sameCredential compares every field", () => {
    const a = { cid: "a", cs: "b", rt: "c", dc: "com" };
    expect(sameCredential(a, { ...a })).toBe(true);
    expect(sameCredential(a, { ...a, rt: "d" })).toBe(false);
    expect(sameCredential({}, undefined)).toBe(true);
    expect(sameCredential(a, {})).toBe(false);
  });

  it("credentialId is stable, differs per refresh token and contains no secret", async () => {
    const one = await credentialId({ cid: "1000.A", rt: "tok1" });
    expect(one).toMatch(/^[0-9a-f]{32}$/);
    expect(await credentialId({ cid: "1000.A", rt: "tok1" })).toBe(one);
    expect(await credentialId({ cid: "1000.A", rt: "tok2" })).not.toBe(one);
  });

  it("maskClientId hides the middle", () => {
    expect(maskClientId("1000.ABCDEFGHIJ")).toBe("1000.A…GHIJ");
    expect(maskClientId("short")).toBe("…");
  });
});

describe("bearer worker wiring", () => {
  const src = readFileSync("src/index.ts", "utf8");

  it("checks header credentials before the bearer gate, and a bad header is a 400", () => {
    expect(src).toMatch(/const own = readHeaderCredential\(request\.headers, env\);/);
    expect(src).toMatch(/if \(!own && !authorized\(request, env\)\)/);
    expect(src.indexOf("readHeaderCredential(request.headers")).toBeLessThan(src.indexOf("!authorized(request, env)"));
  });

  it("a header client never uses the worker's ZOHO_* secrets or URL overrides", () => {
    const fn = src.slice(src.indexOf("export function clientFromHeaders"), src.indexOf("const isHeaderCred"));
    expect(fn).not.toMatch(/env\.ZOHO_(CLIENT|REFRESH|ACCESS|ORG|DC|ANALYTICS_BASE|ACCOUNTS_BASE)/);
    expect(fn).toMatch(/headerTokenStore\(env\.TOKEN_KV, cred\)/);
  });

  it("props follow each request through __unsafe_ensureInitialized", () => {
    expect(src).toMatch(/override async __unsafe_ensureInitialized\(props\?: HeaderProps\)/);
    expect(src).toMatch(/if \(!sameCredential\(next, this\.props\)\) await this\.updateProps\(next\);/);
  });

  it("agents still re-sends props through __unsafe_ensureInitialized on every request", () => {
    const routing = readFileSync("node_modules/agents/dist/agent-routing.js", "utf8");
    expect(routing).toMatch(/__unsafe_ensureInitialized\(options\?\.props\)/);
  });
});

describe("health with header credentials", () => {
  it("a bearer copy with no owner secrets is healthy when BYO is on", () => {
    const body = healthBody({ ZOHO_DC: "com" } as never, "bearer", [], { ownClients: true });
    expect(body.ok).toBe(true);
  });
});
