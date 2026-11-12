import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { readFileSync } from "node:fs";
import { credentialSource, finishManaged, handleManaged, managed, mask, type Props } from "../src/managed.js";
import { exchangeCode, openParked, parseSealedState } from "../src/byo.js";
import { healthBody } from "../src/health.js";
import { EmaKeyStore } from "../src/managed-auth.js";

/**
 * src/oauth.ts imports agents (Workers runtime only). This builds the same provider from the same
 * pieces (src/managed.ts); its /mcp handler reports the grant's props, which is exactly what
 * ZohoAnalyticsMCP.init() reads.
 */

function memKV() {
  const m = new Map<string, string>();
  return {
    async get(k: string, t?: any) {
      const v = m.get(k);
      if (v === undefined) return null;
      return t === "json" || t?.type === "json" ? JSON.parse(v) : v;
    },
    async put(k: string, v: string) {
      m.set(k, v);
    },
    async delete(k: string) {
      m.delete(k);
    },
    async list({ prefix = "" }: { prefix?: string } = {}) {
      return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true, cursor: "" };
    },
    _map: m,
  } as unknown as KVNamespace & { _map: Map<string, string> };
}

type Env = Record<string, any>;
const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;

/** Mirrors oauth.ts: /managed + the sealed /zoho/callback branch for a parked managed setup. */
/** In-memory EMA_KEYS namespace running the real EmaKeyStore (like workerd: requests wait for blockConcurrencyWhile). */
function keyStoreNs(storage = new Map<string, unknown>()) {
  const objs = new Map<string, EmaKeyStore>();
  let ready: Promise<unknown> = Promise.resolve();
  const state = {
    storage: { get: async (k: string) => storage.get(k) as any, put: async (k: string, v: unknown) => void storage.set(k, v) },
    blockConcurrencyWhile: <T,>(fn: () => Promise<T>) => (ready = fn()) as Promise<T>,
  };
  const ns = {
    idFromName: (n: string) => n,
    get: (id: string) => {
      if (!objs.has(id)) objs.set(id, new EmaKeyStore(state));
      const o = objs.get(id)!;
      return { fetch: async () => (await ready, o.fetch()) };
    },
  };
  return { ns: ns as unknown as DurableObjectNamespace, storage };
}

function worker(env: Env) {
  const provider = new OAuthProvider({
    apiHandlers: {
      "/mcp": {
        fetch: async (_req: Request, _e: Env, c: ExecutionContext & { props?: Props }) => Response.json({ props: c.props, source: credentialSource(c.props) }),
      } as never,
    },
    defaultHandler: {
      fetch: async (req: Request, e: Env) => {
        const url = new URL(req.url);
        if (url.pathname === "/managed") return handleManaged(req, e as never);
        if (url.pathname === "/zoho/callback") {
          const st = parseSealedState(url.searchParams.get("state") ?? "");
          const sealed = st ? await e.OAUTH_KV.get(`authreq:${st.id}`) : null;
          if (!st || !sealed) return new Response("expired", { status: 400 });
          await e.OAUTH_KV.delete(`authreq:${st.id}`);
          const parked: any = await openParked(sealed, st.key);
          const res = await exchangeCode(parked.client, url.searchParams.get("code") ?? "", `${url.origin}/zoho/callback`);
          if (!res.ok) return new Response("failed", { status: 502 });
          return finishManaged(e as never, url.origin, parked.managed, parked.client, res.refreshToken, res.accessToken);
        }
        return new Response("Not found", { status: 404 });
      },
    } as never,
    resourceMetadata: { resource: "https://w/mcp" },
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
    clientIdMetadataDocumentEnabled: true,
    enterpriseManagedAuthorization: managed.emaOptions(env),
  });
  return (req: Request) => provider.fetch(req, env as never, ctx);
}

afterEach(() => vi.restoreAllMocks());
beforeAll(() => void ((globalThis as any).Cloudflare = { compatibilityFlags: { global_fetch_strictly_public: true } }));
afterAll(() => void delete (globalThis as any).Cloudflare);

const ISS = "https://identity.anthropic.com/issuers/iss_test123";
const JWKS = `${ISS}/jwks`;
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const RESOURCE = "https://w/mcp";
const enc = new TextEncoder();
const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const j64 = (o: unknown) => b64u(enc.encode(JSON.stringify(o)));

/** Fake Zoho (EU data center; client ORG-CID/ORG-CS, grant code "good") + fake Claude issuer. */
async function fakes() {
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  const keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = { ...(await crypto.subtle.exportKey("jwk", keys.publicKey)), kid: "k1", alg: "ES256", use: "sig" };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.startsWith("https://w/")) return realFetch(input, init);
    if (url === `${ISS}/.well-known/openid-configuration`) return Response.json({ issuer: ISS, jwks_uri: JWKS });
    if (url === JWKS) return Response.json({ keys: [jwk] });
    if (url === "https://accounts.zoho.eu/oauth/v2/token") {
      const b = new URLSearchParams(init.body);
      calls.push(`token:${b.get("redirect_uri") ? "redirect" : "self"}`);
      if (b.get("client_id") !== "ORG-CID" || b.get("client_secret") !== "ORG-CS" || b.get("code") !== "good") return Response.json({ error: "invalid_code" });
      return Response.json({ access_token: "AT-ORG", refresh_token: "RT-ORG-SECRET", expires_in: 3600 });
    }
    if (url === "https://analyticsapi.zoho.eu/restapi/v2/orgs") {
      calls.push("orgs");
      if (new Headers(init?.headers).get("authorization") !== "Zoho-oauthtoken AT-ORG") return new Response("{}", { status: 401 });
      return Response.json({ data: { orgs: [{ orgId: 222 }, { orgId: 111, isDefault: true }] } });
    }
    return new Response("{}", { status: 404 });
  });
  const sign = async (claims: Record<string, unknown>) => {
    const now = Math.floor(Date.now() / 1000);
    const body = `${j64({ alg: "ES256", typ: "oauth-id-jag+jwt", kid: "k1" })}.${j64({ iss: ISS, sub: "u_1", aud: "https://w", resource: RESOURCE, jti: crypto.randomUUID(), iat: now, exp: now + 60, ...claims })}`;
    const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, enc.encode(body)));
    return `${body}.${b64u(sig)}`;
  };
  return { sign, calls };
}

type W = ReturnType<typeof worker>;
async function register(w: W): Promise<string> {
  const res = await w(
    new Request("https://w/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", client_name: "Claude" }),
    }),
  );
  return ((await res.json()) as any).client_id;
}
const post = (w: W, path: string, fields: Record<string, string>) => w(new Request(`https://w${path}`, { method: "POST", body: new URLSearchParams(fields) }));
const mcp = async (w: W, token: string) => (await (await w(new Request(RESOURCE, { method: "POST", headers: { authorization: `Bearer ${token}` } }))).json()) as any;
const ORG = { issuer: ISS, client_id: "ORG-CID", client_secret: "ORG-CS", dc: "eu" };

describe("claude.ai managed authorization", () => {
  it("is off without ZOHO_EMA_SECRET, and /health says so without flipping ok", async () => {
    const w = worker({ OAUTH_KV: memKV() });
    expect((await w(new Request("https://w/managed"))).status).toBe(503);
    const meta: any = await (await w(new Request("https://w/.well-known/oauth-authorization-server"))).json();
    expect(meta.grant_types_supported).not.toContain("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const h = healthBody({}, "oauth", [], { ownClients: true, managed: false }) as any;
    expect(h.ok).toBe(true);
    expect(h.warnings.join(" ")).toContain("ZOHO_EMA_SECRET");
    expect((healthBody({}, "oauth", [], { ownClients: true, managed: true }) as any).credentialModes).toContain("managed");
  });

  it("owner binds the org's Zoho client with a Self Client code; members run on it", async () => {
    const kv = memKV();
    const w = worker({ OAUTH_KV: kv, ZOHO_EMA_SECRET: "seal-secret" });
    const f = await fakes();
    const meta: any = await (await w(new Request("https://w/.well-known/oauth-authorization-server"))).json();
    expect(meta.grant_types_supported).toContain("urn:ietf:params:oauth:grant-type:jwt-bearer");
    expect(meta.client_id_metadata_document_supported).toBe(true);

    const first = await w(new Request("https://w/managed"));
    const firstHtml = await first.text();
    expect(firstHtml).not.toContain("Remove setup");
    expect(firstHtml).toContain("data:image/png;base64,");
    expect(firstHtml).toContain("https://w/zoho/callback");
    expect(first.headers.get("content-security-policy")).toContain("https://accounts.zoho.eu");

    const badIss = await (await post(w, "/managed", { ...ORG, action: "save", issuer: "https://evil.example.com/issuers/x", domains: "example.com", org_id: "111" })).text();
    expect(badIss).toContain("not a Claude Issuer URL");
    expect(badIss).toContain('value="example.com"');
    expect(badIss).toContain('value="ORG-CID"');
    expect(badIss).toContain('value="111"');
    expect(badIss).toContain('<option value="eu" selected>');
    expect(badIss).not.toContain("ORG-CS");

    expect(await (await post(w, "/managed", { ...ORG, action: "save", code: "expired" })).text()).toContain("Zoho rejected that client or code");
    expect(await (await post(w, "/managed", { ...ORG, action: "save", code: "good", org_id: "999" })).text()).toContain("no Zoho Analytics organization 999");

    const done = await post(w, "/managed", { ...ORG, action: "save", code: "good", domains: "example.com" });
    expect(done.status).toBe(200);
    const html = await done.text();
    const tenant = /value="(tn_[\w-]+)"/.exec(html)![1];
    expect(html).toContain('data-copy="tenant-id"');
    expect(html).not.toContain("Remove setup");
    for (const v of kv._map.values()) {
      expect(v).not.toContain("ORG-CS");
      expect(v).not.toContain("RT-ORG-SECRET");
    }

    const clientId = await register(w);
    const tokenFor = (assertion: string) => post(w, "/token", { grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion, client_id: clientId, resource: RESOURCE });
    const res = await tokenFor(await f.sign({ client_id: clientId, email: "member@example.com", aud_tenant: tenant }));
    expect(res.status).toBe(200);
    const tok: any = await res.json();
    expect(tok.expires_in).toBe(3600);
    expect(tok.refresh_token).toBeUndefined();
    const a = await mcp(w, tok.access_token);
    expect(a).toMatchObject({ source: "managed", props: { zohoRefreshToken: "RT-ORG-SECRET", cid: "ORG-CID", cs: "ORG-CS", dc: "eu", org: "111", m: true } });
    expect(a.props.user).toMatch(/^org-[0-9a-f]{24}$/);
    // A second member shares the same token slot (Zoho caps access-token mints per refresh token).
    const b = await mcp(w, ((await (await tokenFor(await f.sign({ client_id: clientId, email: "two@example.com", aud_tenant: tenant }))).json()) as any).access_token);
    expect(b.props.user).toBe(a.props.user);
    expect((await tokenFor(await f.sign({ client_id: clientId, email: "x@other.example", aud_tenant: tenant }))).status).toBe(400);

    const rmWrong = await post(w, "/managed?manage=1", { action: "remove", tenant, client_id: "ORG-CID", client_secret: "nope" });
    expect(await rmWrong.text()).toContain("different credential");
    const rm = await post(w, "/managed?manage=1", { action: "remove", tenant, client_id: "ORG-CID", client_secret: "ORG-CS" });
    expect(await rm.text()).toContain("Setup removed");
    expect((await tokenFor(await f.sign({ client_id: clientId, email: "member@example.com", aud_tenant: tenant }))).status).toBe(400);
  });

  it("needs no secret: the worker generates and keeps its own seal key", async () => {
    const kv = memKV();
    const ks = keyStoreNs();
    const env: Env = { OAUTH_KV: kv, EMA_KEYS: ks.ns };
    const w = worker(env);
    const f = await fakes();
    expect((await w(new Request("https://w/managed"))).status).toBe(200);
    const meta: any = await (await w(new Request("https://w/.well-known/oauth-authorization-server"))).json();
    expect(meta.grant_types_supported).toContain("urn:ietf:params:oauth:grant-type:jwt-bearer");

    const html = await (await post(w, "/managed", { ...ORG, action: "save", code: "good" })).text();
    const tenant = /value="(tn_[\w-]+)"/.exec(html)![1];
    const key = ks.storage.get("ema-seal-key") as string;
    expect(key.length).toBeGreaterThanOrEqual(43);
    for (const v of kv._map.values()) {
      expect(v).not.toContain("ORG-CS");
      expect(v).not.toContain(key);
    }

    // After a restart (fresh isolate, same Durable Object storage) members still get in.
    const w2 = worker({ ...env, EMA_KEYS: keyStoreNs(ks.storage).ns });
    const clientId = await register(w2);
    const res = await post(w2, "/token", { grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: await f.sign({ client_id: clientId, email: "member@example.com", aud_tenant: tenant }), client_id: clientId, resource: RESOURCE });
    expect(res.status).toBe(200);
    expect(await mcp(w2, ((await res.json()) as any).access_token)).toMatchObject({ props: { cid: "ORG-CID", m: true } });
    expect(ks.storage.get("ema-seal-key")).toBe(key);
  });

  it("can sign in on Zoho's own screen with a server-based client", async () => {
    const w = worker({ OAUTH_KV: memKV(), ZOHO_EMA_SECRET: "seal-secret" });
    const f = await fakes();
    const go = await post(w, "/managed", { ...ORG, action: "save" });
    expect(go.status).toBe(302);
    const to = new URL(go.headers.get("location")!);
    expect(to.origin + to.pathname).toBe("https://accounts.zoho.eu/oauth/v2/auth");
    expect(to.searchParams.get("client_id")).toBe("ORG-CID");
    expect(to.searchParams.get("redirect_uri")).toBe("https://w/zoho/callback");
    expect(to.searchParams.get("access_type")).toBe("offline");
    const state = to.searchParams.get("state")!;
    const back = await w(new Request(`https://w/zoho/callback?code=good&state=${encodeURIComponent(state)}`));
    expect(back.status).toBe(200);
    expect(await back.text()).toMatch(/value="tn_[\w-]+"/);
    expect(f.calls).toEqual(["token:redirect", "orgs"]);
    expect((await w(new Request(`https://w/zoho/callback?code=good&state=${encodeURIComponent(state)}`))).status).toBe(400);
  });

  it("credential source and masking", () => {
    expect(credentialSource({ user: "org-1", cid: "a", cs: "b", m: true })).toBe("managed");
    expect(credentialSource({ user: "u", cid: "a", cs: "b" })).toBe("own_client");
    expect(credentialSource({ user: "u", zohoRefreshToken: "r" })).toBe("zoho_login");
    expect(credentialSource({ user: "owner" })).toBe("owner");
    expect(mask("1000.ABCDEFGHIJ")).toBe("1000…GHIJ");
    expect(mask("short")).toBe("…");
  });
});

describe("oauth.ts wiring", () => {
  it("routes /managed, finishes a parked managed sign-in, resource = <origin>/mcp", () => {
    const src = readFileSync("src/oauth.ts", "utf8");
    expect(src).toMatch(/pathname === "\/managed"\) return handleManaged\(request, env\)/);
    expect(src).toMatch(/if \(parked\.managed\) return finishManaged\(/);
    expect(src).toMatch(/resourceMetadata: \{ resource: `\$\{origin\}\/mcp`/);
    expect(src).toMatch(/clientIdMetadataDocumentEnabled: true/);
    expect(src).toMatch(/enterpriseManagedAuthorization: managed\.emaOptions\(env\)/);
    expect(src).toMatch(/credential: \{ source: credentialSource\(props\)/);
    const wr = readFileSync("wrangler.oauth.jsonc", "utf8");
    expect(wr).toContain("global_fetch_strictly_public");
    // The generated seal key: exported, bound, migrated. Never delete or rename any of it.
    expect(src).toMatch(/export \{ EmaKeyStore \} from "\.\/managed-auth\.js"/);
    expect(wr).toMatch(/"name": "EMA_KEYS", "class_name": "EmaKeyStore"/);
    expect(wr).toMatch(/"new_sqlite_classes": \["EmaKeyStore"\]/);
  });
});
