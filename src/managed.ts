/**
 * claude.ai Managed authorization (shared MCP worker standard §3C) for the Zoho Analytics connector.
 *
 * A Claude Team/Enterprise owner opens /managed once and binds ONE Zoho Analytics account to their
 * Claude organisation: the organisation's own Zoho API client (client id + secret + data center),
 * plus either a Self Client grant code or a Zoho sign-in with a server-based client. The worker
 * exchanges it for a refresh token, checks it with the same call zoho_whoami makes (list orgs), and
 * seals everything in the binding. Members then connect with no sign-in: their grants carry
 * `{user: "org-<slot>", zohoRefreshToken, cid, cs, dc, org, m: true}` and run exactly like an
 * own-client grant. `slot` is shared by the whole organisation, so the access-token cache (Zoho
 * allows ~10 mints per 10 minutes per refresh token) and the schema cache are shared too.
 *
 * Seal key: ZOHO_EMA_SECRET if set (never rotate it), else the worker's own generated key in the
 * EMA_KEYS Durable Object (never delete or rename it): either seals every binding. Changing or removing
 * a setup needs the same client id + secret (the binding's owner is a hash of them).
 *
 * Node-testable: no `cloudflare:workers` import.
 */
import { createManagedAuth, normalizeIssuer, parseDomains } from "./managed-auth.js";
import { BRAND, copyField, esc, renderPage } from "./ui.js";
import { DC_DOMAINS } from "./zohoanalytics.js";
import { ZOHO_SCOPE, accountsOrigin, exchangeCode, fetchOrgs, readByoForm, sealParked, type ByoClient } from "./byo.js";
import { clientIp, isLockedOut, recordFailedAttempt } from "./throttle.js";

export interface ManagedEnv {
  OAUTH_KV: KVNamespace;
  ZOHO_EMA_SECRET?: string;
  /** Keeps the worker's own generated seal key (EmaKeyStore). Never delete or rename it. */
  EMA_KEYS?: DurableObjectNamespace;
}

/** The organisation's Zoho credential, sealed inside the binding. */
export interface OrgCred {
  cid: string;
  cs: string;
  dc: string;
  org: string;
  rt: string;
  /** Random id shared by every member's grant (token + schema cache namespace). */
  slot: string;
}

/** Grant props shared with src/oauth.ts. */
export type Props = { user: string; zohoRefreshToken?: string; cid?: string; cs?: string; dc?: string; org?: string; m?: boolean };

export const managed = createManagedAuth<OrgCred>({
  kvPrefix: "zoho:",
  sealSecretName: "ZOHO_EMA_SECRET",
  generatedKeyBinding: "EMA_KEYS",
  credentialId: (c) => `${c.cid}|${c.cs}`,
  toProps: (c) => ({ user: `org-${c.slot}`, zohoRefreshToken: c.rt, cid: c.cid, cs: c.cs, dc: c.dc, org: c.org, m: true }) satisfies Props,
});

/** Which kind of credential a grant runs on (zoho_whoami `credential_source`). */
export function credentialSource(p: Props | undefined): "managed" | "own_client" | "zoho_login" | "owner" {
  if (p?.m) return "managed";
  if (p?.cid && p.cs) return "own_client";
  if (p?.zohoRefreshToken) return "zoho_login";
  return "owner";
}

/** first4…last4, never the whole value. */
export function mask(v: string | undefined): string | undefined {
  if (!v) return undefined;
  return v.length <= 10 ? "…" : `${v.slice(0, 4)}…${v.slice(-4)}`;
}

/** A setup waiting for the owner to come back from Zoho's sign-in screen (sealed in KV, key only in `state`). */
export interface ManagedSetup {
  issuer: string;
  domains: string[];
  tenant?: string;
}

/** /managed posts to itself and, for "sign in on Zoho", on to the data center's accounts host. */
export const MANAGED_FORM_ACTION = `'self' ${[...new Set(Object.values(DC_DOMAINS).map((d) => `https://${d.accounts}`))].join(" ")}`;

interface View {
  origin: string;
  error?: string;
  done?: { tenantId: string; issuer: string; domains: string[] };
  removed?: boolean;
  mode?: "new" | "manage";
  /** What the user typed, re-filled after an error (§12A). Never a secret. */
  values?: { issuer?: string; domains?: string; tenant?: string; clientId?: string; dc?: string; org?: string };
}

function dcOptions(selected = "com"): string {
  return Object.keys(DC_DOMAINS)
    .map((d) => `<option value="${d}"${d === selected ? " selected" : ""}>${esc(DC_DOMAINS[d]!.accounts)}</option>`)
    .join("");
}

export function managedPage(v: View, status = 200): Response {
  const manage = v.mode === "manage";
  const val = (k: keyof NonNullable<View["values"]>) => (v.values?.[k] ? ` value="${esc(v.values[k]!)}"` : "");
  const save = `<form method="post" action="/managed${manage ? "?manage=1" : ""}"><input type="hidden" name="action" value="save">
<fieldset><legend>1. From Claude</legend>
<label>Issuer URL (Claude: Organization settings → Connectors → ${esc(BRAND.name)} → Managed authorization)<input name="issuer" placeholder="https://identity.anthropic.com/issuers/…" required autocomplete="off"${val("issuer")}></label>
${manage ? `<label>Tenant ID of the setup to change<input name="tenant" placeholder="tn_…" required autocomplete="off"${val("tenant")}></label>` : ""}</fieldset>
<fieldset><legend>2. Who</legend>
<label>Allowed email domains (optional, e.g. example.com; empty = every member)<input name="domains" placeholder="example.com" autocomplete="off"${val("domains")}></label></fieldset>
<fieldset><legend>3. The Zoho Analytics account the whole organisation will use</legend>
<p class="muted">Create a client at <a href="https://api-console.zoho.com" target="_blank" rel="noopener">api-console.zoho.com</a>. Members act as the Zoho user who authorizes it here, with that user's permissions.</p>
<label>Client ID<input name="client_id" required autocomplete="off"${val("clientId")}></label>
<label>Client secret${v.error ? " (paste it again)" : ""}<input name="client_secret" type="password" required autocomplete="off"></label>
<label>Data center<select name="dc">${dcOptions(v.values?.dc)}</select></label>
<label>Organization ID (optional; the account's default organization if empty)<input name="org_id" inputmode="numeric" autocomplete="off"${val("org")}></label>
<label>Self Client grant code (optional)<input name="code" autocomplete="off"></label>
<p class="muted">Self Client: Generate Code with scope <code>${ZOHO_SCOPE}</code> and paste it above. Server-based client: leave the code empty and sign in on Zoho; its redirect URI must be <code>${esc(v.origin)}/zoho/callback</code>.</p></fieldset>
<button type="submit">${manage ? "Save changes" : "Save"}</button></form>`;
  const remove = `<form method="post" action="/managed?manage=1"><fieldset><legend>Remove this setup</legend><input type="hidden" name="action" value="remove">
<label>Tenant ID<input name="tenant" required autocomplete="off"${val("tenant")}></label>
<label>Client ID of the Zoho client this setup uses<input name="client_id" autocomplete="off" required${val("clientId")}></label>
<label>Client secret<input name="client_secret" type="password" autocomplete="off" required></label>
<button type="submit" class="secondary">Remove setup</button></fieldset></form>`;
  const intro = `<h1>${esc(BRAND.name)}: managed authorization</h1>
<p>For a Claude Team or Enterprise owner: connect ${esc(BRAND.name)} once for the whole organisation. Members then use it in Claude without a connector sign-in.</p>`;
  const err = v.error ? `<p class="err" role="alert">${esc(v.error)}</p>` : "";
  let body: string;
  if (v.done) {
    const d = v.done;
    body = `${intro}<div class="ok"><b>Saved.</b> Paste this into Claude's <b>Tenant ID</b> field, then click <b>Test connection</b>:
${copyField("tenant-id", d.tenantId, "Copy")}
<p class="muted">Keep it: you need it, with the same client ID and secret, to change or remove the setup. ${d.domains.length ? `Only ${esc(d.domains.join(", "))} addresses can sign in.` : "Every member of that Claude organisation can sign in."}</p></div>
<p class="muted"><a href="/managed?manage=1">Change or remove a setup</a></p>`;
  } else if (v.removed) {
    body = `${intro}<div class="ok"><b>Setup removed.</b> Members lose access when their current token expires (at most an hour).</div><p class="muted"><a href="/managed">Set up again</a></p>`;
  } else if (manage) {
    body = `${intro}${err}<p class="muted">Changing an existing setup. <a href="/managed">New setup instead</a></p>${save}${remove}`;
  } else {
    body = `${intro}${err}${save}<p class="muted">Already set up? <a href="/managed?manage=1">Change or remove it</a></p>`;
  }
  return renderPage(body, { status, title: `${BRAND.name}: managed authorization`, subtitle: "Managed authorization", formAction: MANAGED_FORM_ACTION });
}

/** Refresh token in hand: find and check the organization, then save the binding. */
export async function finishManaged(
  env: ManagedEnv,
  origin: string,
  setup: ManagedSetup,
  client: Omit<ByoClient, "code">,
  refreshToken: string,
  accessToken: string | undefined,
  fetchImpl?: typeof fetch,
): Promise<Response> {
  const values = { issuer: setup.issuer, domains: setup.domains.join(", "), tenant: setup.tenant, clientId: client.clientId, dc: client.dc, org: client.orgId };
  const fail = (error: string, status = 400) => managedPage({ origin, error, mode: setup.tenant ? "manage" : "new", values }, status);
  const orgs = accessToken ? await fetchOrgs(client.dc, accessToken, fetchImpl) : null;
  if (!orgs) return fail("Zoho accepted the client, but Zoho Analytics did not answer for this account. Check the data center and that the user has Zoho Analytics, then try again.", 502);
  let org = client.orgId;
  if (org && !orgs.some((o) => o.orgId === org)) return fail(`This Zoho user has no Zoho Analytics organization ${org}. Leave the Organization ID empty to use the default one.`);
  org ??= (orgs.find((o) => o.isDefault) ?? orgs[0])?.orgId;
  if (!org) return fail("This Zoho user has no Zoho Analytics organization.");
  const slot = [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const cred: OrgCred = { cid: client.clientId, cs: client.clientSecret, dc: client.dc, org, rt: refreshToken, slot };
  const r = await managed.saveBinding(env, { issuer: setup.issuer, credential: cred, domains: setup.domains, tenantId: setup.tenant });
  if (!r.ok) return fail(r.error);
  return managedPage({ origin, done: r.binding });
}

/** §3C.7 setup page. A working Zoho client + a successful Zoho authorization are the gate. */
export async function handleManaged(request: Request, env: ManagedEnv, fetchImpl?: typeof fetch): Promise<Response> {
  const url = new URL(request.url);
  const origin = url.origin;
  if (!managed.enabled(env)) {
    return renderPage(`<h1>Managed authorization</h1><p>Managed authorization is not enabled on this server.</p>`, {
      status: 503,
      title: "Managed authorization",
      formAction: "'self'",
    });
  }
  const mode: "new" | "manage" = url.searchParams.has("manage") ? "manage" : "new";
  if (request.method === "GET") return managedPage({ origin, mode });
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const fd = await request.formData();
  const field = (n: string, max: number) => String(fd.get(n) ?? "").trim().slice(0, max);
  const action = field("action", 10) === "remove" ? "remove" : "save";
  const tenant = field("tenant", 80);
  const values = { issuer: field("issuer", 300), domains: field("domains", 500), tenant, clientId: field("client_id", 200), dc: field("dc", 10), org: field("org_id", 25) };
  const fail = (error: string, status = 400) => managedPage({ origin, error, mode: action === "remove" || tenant ? "manage" : mode, values }, status);
  const ip = clientIp(request);
  if (await isLockedOut(env.OAUTH_KV, ip)) return fail("Too many failed attempts. Try again in 15 minutes.", 429);

  if (action === "remove") {
    const cs = field("client_secret", 200);
    if (!values.clientId || !cs) return fail("Paste the client ID and secret of the Zoho client this setup uses.");
    const r = await managed.removeBinding(env, tenant, { cid: values.clientId, cs, dc: "", org: "", rt: "", slot: "" });
    if (!r.ok) await recordFailedAttempt(env.OAUTH_KV, ip);
    return r.ok ? managedPage({ origin, removed: true }) : fail(r.error);
  }

  const issuer = normalizeIssuer(values.issuer);
  if (!issuer) return fail(`That is not a Claude Issuer URL. Copy it from Claude's "Managed authorization" dialog; it looks like https://identity.anthropic.com/issuers/…`);
  const domains = parseDomains(values.domains);
  if (!domains) return fail("Allowed email domains: plain domains only, e.g. example.com.");
  const parsed = readByoForm(fd);
  if ("error" in parsed) return fail(parsed.error);
  const { code, ...client } = parsed;
  const setup: ManagedSetup = { issuer, domains, ...(tenant ? { tenant } : {}) };

  if (!code) {
    // Server-based client: sign in on Zoho; the setup and the client ride sealed in KV.
    const { id, state, sealed } = await sealParked({ client, managed: setup });
    await env.OAUTH_KV.put(`authreq:${id}`, sealed, { expirationTtl: 600 });
    const auth = new URL(`${accountsOrigin(client.dc)}/oauth/v2/auth`);
    auth.searchParams.set("scope", ZOHO_SCOPE);
    auth.searchParams.set("client_id", client.clientId);
    auth.searchParams.set("response_type", "code");
    auth.searchParams.set("access_type", "offline");
    auth.searchParams.set("prompt", "consent");
    auth.searchParams.set("redirect_uri", `${origin}/zoho/callback`);
    auth.searchParams.set("state", state);
    return Response.redirect(auth.toString(), 302);
  }

  const res = await exchangeCode(client, code, undefined, fetchImpl);
  if (!res.ok) {
    if (res.error === "network") return fail("Couldn't reach Zoho. Try again in a minute.", 502);
    await recordFailedAttempt(env.OAUTH_KV, ip);
    return fail(`Zoho rejected that client or code (${res.error}). Codes expire after a few minutes; generate a new one.`);
  }
  return finishManaged(env, origin, setup, client, res.refreshToken, res.accessToken, fetchImpl);
}
