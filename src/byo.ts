/**
 * Bring-your-own Zoho API client on the claude.ai connector (shared MCP worker standard §3A).
 *
 * A user pastes THEIR OWN Zoho API Console client (client ID + secret) and data center on
 * the consent screen, then gets a refresh token with it either:
 *   - from a Self Client: they generate a grant code (scope ZohoAnalytics.fullaccess.all)
 *     in the API Console and paste it, and the worker exchanges it once; or
 *   - from a Server-based client: they're sent to Zoho's login with their client id
 *     (its redirect URI must be <origin>/zoho/callback).
 * The client id/secret, refresh token, DC and org id ride in the grant's props, which the
 * OAuth provider stores encrypted. The operator's ZOHO_* secrets are never used for them.
 *
 * Pure / fetch-only, so it runs under Node in tests.
 */
import { DC_DOMAINS } from "./zohoanalytics.js";

export const ZOHO_SCOPE = "ZohoAnalytics.fullaccess.all";

const enc = new TextEncoder();

function b64u(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64u(s: string): Uint8Array {
  const p = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(p + "=".repeat((4 - (p.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Seal a short-lived blob (the parked OAuth request + the user's client) for KV. The AES key
 * is random and travels ONLY in the returned `state` (`<id>.<key>`), so the KV entry alone
 * can't be decrypted.
 */
export async function sealParked(payload: unknown): Promise<{ id: string; state: string; sealed: string }> {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const key = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(payload))));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  const id = crypto.randomUUID();
  return { id, state: `${id}.${b64u(raw)}`, sealed: b64u(out) };
}

/** Split a sealed state into its KV id and key; null for anything else (e.g. a plain UUID state). */
export function parseSealedState(state: string): { id: string; key: string } | null {
  const m = /^([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/.exec(state);
  return m ? { id: m[1], key: m[2] } : null;
}

export async function openParked<T>(sealed: string, keyB64u: string): Promise<T | null> {
  try {
    const raw = unb64u(sealed);
    const key = await crypto.subtle.importKey("raw", unb64u(keyB64u), { name: "AES-GCM" }, false, ["decrypt"]);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: raw.slice(0, 12) }, key, raw.slice(12));
    return JSON.parse(new TextDecoder().decode(pt)) as T;
  } catch {
    return null;
  }
}

export interface ByoClient {
  clientId: string;
  clientSecret: string;
  dc: string;
  /** Optional; looked up from the account when empty. */
  orgId?: string;
  /** Self Client grant code. Empty → Zoho login with a server-based client. */
  code?: string;
}

const PRINTABLE = /^[\x21-\x7e]+$/;

/** Validate the consent-form fields. Returns the client or a user-facing error. */
export function readByoForm(form: FormData): ByoClient | { error: string } {
  const get = (k: string) => String(form.get(k) ?? "").trim();
  const clientId = get("client_id");
  const clientSecret = get("client_secret");
  const dc = (get("dc") || "com").toLowerCase();
  const orgId = get("org_id");
  const code = get("code");
  if (!clientId || !clientSecret) return { error: "Paste both the client ID and the client secret of your Zoho API client." };
  if (clientId.length > 200 || clientSecret.length > 200 || !PRINTABLE.test(clientId + clientSecret)) {
    return { error: "That doesn't look like a Zoho API client." };
  }
  if (!(dc in DC_DOMAINS)) return { error: "Pick your Zoho data center." };
  if (orgId && !/^\d{1,20}$/.test(orgId)) return { error: "The organization ID is a number (leave it empty to use your default organization)." };
  if (code && (code.length > 500 || !PRINTABLE.test(code))) return { error: "That doesn't look like a Zoho grant code." };
  return { clientId, clientSecret, dc, ...(orgId ? { orgId } : {}), ...(code ? { code } : {}) };
}

export const accountsOrigin = (dc: string) => `https://${(DC_DOMAINS[dc] ?? DC_DOMAINS.com).accounts}`;
export const analyticsOrigin = (dc: string) => `https://${(DC_DOMAINS[dc] ?? DC_DOMAINS.com).api}`;

/** Exchange a grant code with the user's own client. Returns the tokens or a short error. */
export async function exchangeCode(
  c: Pick<ByoClient, "clientId" | "clientSecret" | "dc">,
  code: string,
  redirectUri: string | undefined,
  fetchImpl: typeof fetch = fetch.bind(globalThis),
): Promise<{ ok: true; refreshToken: string; accessToken?: string } | { ok: false; error: string }> {
  const body = new URLSearchParams({ grant_type: "authorization_code", client_id: c.clientId, client_secret: c.clientSecret, code });
  if (redirectUri) body.set("redirect_uri", redirectUri);
  let res: Response;
  try {
    res = await fetchImpl(`${accountsOrigin(c.dc)}/oauth/v2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return { ok: false, error: "network" };
  }
  const data = (await res.json().catch(() => ({}))) as { refresh_token?: string; access_token?: string; error?: string };
  if (!data.refresh_token) return { ok: false, error: data.error ?? `HTTP ${res.status}` };
  return { ok: true, refreshToken: data.refresh_token, accessToken: data.access_token };
}

/** Best-effort: the account's default (else first) organization id, or undefined. */
export async function defaultOrgId(
  dc: string,
  accessToken: string | undefined,
  fetchImpl: typeof fetch = fetch.bind(globalThis),
): Promise<string | undefined> {
  if (!accessToken) return undefined;
  try {
    const res = await fetchImpl(`${analyticsOrigin(dc)}/restapi/v2/orgs`, {
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return undefined;
    const j = (await res.json()) as { data?: { orgs?: Array<{ orgId?: string | number; isDefault?: boolean }> } };
    const orgs = j.data?.orgs ?? [];
    const pick = orgs.find((o) => o.isDefault) ?? orgs[0];
    return pick?.orgId !== undefined ? String(pick.orgId) : undefined;
  } catch {
    return undefined;
  }
}
