import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { defaultOrgId, exchangeCode, openParked, parseSealedState, readByoForm, sealParked } from "../src/byo.js";
import { healthBody } from "../src/health.js";

// Bring-your-own Zoho API client on the claude.ai connector (shared MCP worker standard §3A).

const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

describe("readByoForm", () => {
  it("needs both halves of the client", () => {
    expect(readByoForm(fd({ client_id: "1000.ABC" }))).toHaveProperty("error");
  });
  it("defaults the DC to com and keeps optional org + code", () => {
    expect(readByoForm(fd({ client_id: " 1000.ABC ", client_secret: "sec" }))).toEqual({ clientId: "1000.ABC", clientSecret: "sec", dc: "com" });
    expect(readByoForm(fd({ client_id: "a", client_secret: "b", dc: "EU", org_id: "123", code: "1000.x.y" }))).toEqual({
      clientId: "a",
      clientSecret: "b",
      dc: "eu",
      orgId: "123",
      code: "1000.x.y",
    });
  });
  it("rejects an unknown DC, a non-numeric org and junk", () => {
    expect(readByoForm(fd({ client_id: "a", client_secret: "b", dc: "mars" }))).toHaveProperty("error");
    expect(readByoForm(fd({ client_id: "a", client_secret: "b", org_id: "acme" }))).toHaveProperty("error");
    expect(readByoForm(fd({ client_id: "a b", client_secret: "c" }))).toHaveProperty("error");
  });
});

describe("parked sign-in state", () => {
  it("opens only with the key carried in the state; KV never holds the secret in clear", async () => {
    const { id, state, sealed } = await sealParked({ client: { clientId: "c", clientSecret: "THEIR-SECRET", dc: "com" } });
    expect(sealed).not.toContain("THEIR-SECRET");
    const st = parseSealedState(state)!;
    expect(st.id).toBe(id);
    expect(await openParked(sealed, st.key)).toEqual({ client: { clientId: "c", clientSecret: "THEIR-SECRET", dc: "com" } });
    expect(await openParked(sealed, parseSealedState((await sealParked({})).state)!.key)).toBeNull();
  });
  it("leaves the multi-user flow's plain UUID states alone", () => {
    expect(parseSealedState(crypto.randomUUID())).toBeNull();
  });
});

describe("exchangeCode", () => {
  it("posts to the user's DC with their client, redirect only when given", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ refresh_token: "RT", access_token: "AT" })));
    expect(await exchangeCode({ clientId: "a", clientSecret: "b", dc: "eu" }, "C", undefined, f as never)).toEqual({ ok: true, refreshToken: "RT", accessToken: "AT" });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://accounts.zoho.eu/oauth/v2/token");
    const body = new URLSearchParams(String(init.body));
    expect(body.get("client_secret")).toBe("b");
    expect(body.has("redirect_uri")).toBe(false);
  });
  it("reports Zoho's error and network failures", async () => {
    expect(await exchangeCode({ clientId: "a", clientSecret: "b", dc: "com" }, "C", "https://x/zoho/callback", (async () => new Response(JSON.stringify({ error: "invalid_code" }))) as never)).toEqual({ ok: false, error: "invalid_code" });
    expect(await exchangeCode({ clientId: "a", clientSecret: "b", dc: "com" }, "C", undefined, (async () => { throw new Error("x"); }) as never)).toEqual({ ok: false, error: "network" });
  });
});

describe("defaultOrgId", () => {
  it("picks the default org, else the first, else undefined", async () => {
    const orgs = (o: unknown[]) => (async () => new Response(JSON.stringify({ data: { orgs: o } }))) as never;
    expect(await defaultOrgId("com", "AT", orgs([{ orgId: 1 }, { orgId: 2, isDefault: true }]))).toBe("2");
    expect(await defaultOrgId("com", "AT", orgs([{ orgId: 7 }]))).toBe("7");
    expect(await defaultOrgId("com", "AT", orgs([]))).toBeUndefined();
    expect(await defaultOrgId("com", undefined, orgs([{ orgId: 7 }]))).toBeUndefined();
  });
});

describe("health", () => {
  it("own-client mode needs no worker-wide Zoho credentials or org", () => {
    const h = healthBody({}, "oauth", [], { ownClients: true });
    expect(h.credentialModes).toEqual(["zoho-own-client"]);
    expect(h.warnings).toEqual([]);
  });
});

describe("connector wiring (source checks; oauth.ts needs the Workers runtime)", () => {
  const src = readFileSync("src/oauth.ts", "utf8");
  it("own-client grants never fall back to the operator's client, org or base URLs", () => {
    expect(src).toMatch(/const clientId = own \? props!\.cid! : this\.env\.ZOHO_CLIENT_ID;/);
    expect(src).toMatch(/const orgId = own \? props!\.org : this\.env\.ZOHO_ORG_ID;/);
    expect(src).toMatch(/analyticsBaseUrl: own \? undefined/);
  });
  it("is on unless MCP_BYO_KEYS is exactly \"false\"", () => {
    expect(src).toContain('env.MCP_BYO_KEYS !== "false"');
  });
  it("re-validates the client redirect and throttles wrong clients", () => {
    expect(src).toMatch(/async function handleByo\([\s\S]*validClientRedirect[\s\S]*isLockedOut[\s\S]*recordFailedAttempt/);
  });
  it("the sign-in state is single use", () => {
    expect(src).toMatch(/OAUTH_KV\.delete\(`authreq:\$\{st\.id\}`\)/);
  });
});
