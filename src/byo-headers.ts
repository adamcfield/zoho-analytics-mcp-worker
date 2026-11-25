/**
 * Bring-your-own Zoho credential in request headers (bearer worker, standard §3A / §13.9).
 *
 * A caller (for example the team access gateway) sends its own Zoho API client plus a refresh
 * token made with it:
 *   X-Zoho-Client-Id + X-Zoho-Client-Secret   the caller's Zoho API Console client
 *   X-Zoho-Refresh-Token                      a refresh token for that client (scope ZohoAnalytics.fullaccess.all)
 *   X-Zoho-DC                                 optional data center (com, eu, in, au, jp, sa, ca, uk, cn; default com)
 *   X-Zoho-Org-Id                             optional Zoho Analytics org id (ZANALYTICS-ORGID)
 *
 * Such a request authenticates with Zoho itself, so it skips the MCP_AUTH_TOKEN gate and never
 * touches the worker's own ZOHO_* client, org, DC, URL overrides or token cache.
 * `MCP_BYO_KEYS="false"` turns it off. Values are never logged or echoed.
 */
import { DC_DOMAINS } from "./zohoanalytics.js";

export interface HeaderCredential {
  cid: string;
  cs: string;
  rt: string;
  dc: string;
  org?: string;
}

export type HeaderResult = { ok: true; cred: HeaderCredential } | { ok: false; error: string } | null;

const NAMES = {
  cid: "x-zoho-client-id",
  cs: "x-zoho-client-secret",
  rt: "x-zoho-refresh-token",
  dc: "x-zoho-dc",
  org: "x-zoho-org-id",
} as const;

const MAX = 512;
const PRINTABLE = /^[\x21-\x7e]+$/;

/** Canonical spelling of a header for messages (X-Zoho-Client-Id). */
function headerName(k: keyof typeof NAMES): string {
  return NAMES[k].replace(/(^|-)([a-z])/g, (_m, d: string, c: string) => d + c.toUpperCase());
}

/** null = no Zoho credential headers at all (use the bearer gate). */
export function readHeaderCredential(headers: Headers, env: { MCP_BYO_KEYS?: string }): HeaderResult {
  const keys = Object.keys(NAMES) as (keyof typeof NAMES)[];
  const got = Object.fromEntries(keys.map((k) => [k, (headers.get(NAMES[k]) ?? "").trim()])) as Record<keyof typeof NAMES, string>;
  if (!keys.some((k) => got[k])) return null;
  if (env.MCP_BYO_KEYS === "false") return { ok: false, error: "This worker does not accept your own Zoho client (MCP_BYO_KEYS=false)." };
  for (const k of keys) {
    const v = got[k];
    if (v && (v.length > MAX || !PRINTABLE.test(v))) return { ok: false, error: `${headerName(k)} is not a valid value.` };
  }
  if (!got.cid || !got.cs || !got.rt) {
    return { ok: false, error: "Send X-Zoho-Client-Id, X-Zoho-Client-Secret and X-Zoho-Refresh-Token together (your own Zoho client and its refresh token)." };
  }
  const dc = (got.dc || "com").toLowerCase();
  if (!(dc in DC_DOMAINS)) return { ok: false, error: `X-Zoho-DC must be one of: ${Object.keys(DC_DOMAINS).join(", ")}.` };
  if (got.org && !/^\d{1,20}$/.test(got.org)) return { ok: false, error: "X-Zoho-Org-Id must be a number (zoho_get_orgs lists it)." };
  return { ok: true, cred: { cid: got.cid, cs: got.cs, rt: got.rt, dc, ...(got.org ? { org: got.org } : {}) } };
}

/** Same credential? (props comparison; no secret ever leaves the worker) */
export function sameCredential(a?: Partial<HeaderCredential> | null, b?: Partial<HeaderCredential> | null): boolean {
  const x = a ?? {};
  const y = b ?? {};
  return x.cid === y.cid && x.cs === y.cs && x.rt === y.rt && x.dc === y.dc && x.org === y.org;
}

/** Stable, non-reversible id for one header credential: namespaces its token and schema caches. */
export async function credentialId(cred: Pick<HeaderCredential, "cid" | "rt">): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`zoho-analytics-byo:${cred.cid}:${cred.rt}`));
  return Array.from(new Uint8Array(digest).slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Client id with the middle hidden, for zoho_whoami. */
export function maskClientId(cid: string): string {
  return cid.length <= 10 ? "…" : `${cid.slice(0, 6)}…${cid.slice(-4)}`;
}
