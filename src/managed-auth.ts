/**
 * claude.ai "Managed authorization" (Claude-issued Enterprise-Managed Authorization).
 *
 * A Claude Team/Enterprise owner sets the connector up once: on this worker's /managed page they
 * enter the upstream credential plus the Issuer URL Claude shows them, and get a Tenant ID to
 * paste back into Claude. From then on Claude signs each member in with no consent screen: it
 * POSTs an ID-JAG (signed JWT, typ oauth-id-jag+jwt, ES256) to /token with
 * grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer, and this module turns that into a
 * normal grant carrying the bound credential.
 *
 * Spec: https://claude.com/docs/connectors/building/enterprise-managed-auth
 * Plumbing: @cloudflare/workers-oauth-provider >= 1.2 `enterpriseManagedAuthorization`
 * (signature, exp/iat/nbf, aud = this AS's issuer, client_id binding, jti replay are checked
 * by the provider). Needs `clientIdMetadataDocumentEnabled: true` and the wrangler compat flag
 * `global_fetch_strictly_public` (Claude registers by CIMD, a public client).
 *
 * Self-contained (WebCrypto + fetch only) and generic over the credential type, so every fleet
 * worker imports this file unchanged. The worker keeps its own setup page and calls
 * saveBinding / removeBinding.
 *
 * KV layout (all under `kvPrefix`):
 *   ema:t:<tenantId>        → binding {v, iss, owner, domains, cred (AES-GCM sealed), at}
 *   ema:i:<sha256(iss)>     → JSON array of tenantIds bound to that issuer
 * The credential is sealed with a key derived from a worker secret + the tenant id. `owner` is a
 * hash of the credential id: only someone holding the same credential can change or remove it.
 *
 * Seal secret, first one available wins: `sealSecretName` (a worker secret), then
 * `fallbackSecretNames`, then (with `generatedKeyBinding`) a key the worker generates once and keeps
 * in its own Durable Object (`EmaKeyStore` below), so no operator has to set any secret. The seal is
 * never the access gate: a binding needs a working upstream credential to create, does nothing
 * until a Claude org admin pastes its Tenant ID into Claude, and only the same credential can
 * change or remove it. Never delete or rename the key store (or rotate the secret): that voids
 * every binding.
 */
import type { EmaOptions } from '@cloudflare/workers-oauth-provider';

/** Claude's issuers live here; nothing else is ever fetched (SSRF guard). */
export const CLAUDE_ISSUER_HOST = 'identity.anthropic.com';
const ISSUER_RE = /^https:\/\/identity\.anthropic\.com\/issuers\/[A-Za-z0-9_-]{1,128}$/;
const TENANT_RE = /^tn_[A-Za-z0-9_-]{16,64}$/;
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export interface ManagedAuthOptions<C> {
  /** KV key prefix this worker owns, e.g. 'dokka:' or 'zforms:'. */
  kvPrefix: string;
  /** Env var (worker secret) that seals bound credentials. */
  sealSecretName: string;
  /** Other secrets to derive the seal key from when `sealSecretName` is unset (first one set wins). */
  fallbackSecretNames?: string[];
  /** Grant props for a member (`email` is the verified, lowercased Claude account email). */
  toProps: (credential: C, email: string) => unknown;
  /** Stable identifier of a credential (e.g. the API key or client id + refresh token). Hashed, never stored. */
  credentialId: (credential: C) => string;
  /** Access token lifetime. Default 3600 s (Claude re-runs the assertion grant after that; no refresh token). */
  accessTokenTTL?: number;
  /** Scopes granted. Default ['mcp']. */
  scopes?: string[];
  /**
   * Durable Object namespace binding (env name) of an `EmaKeyStore`: the worker generates and keeps
   * its own seal key there when no seal secret is set. Optional; without it managed auth needs a secret.
   */
  generatedKeyBinding?: string;
  /** KV binding. Default env.OAUTH_KV. */
  kv?: (env: any) => KVNamespace | undefined;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
}

export interface Binding {
  tenantId: string;
  issuer: string;
  /** Lowercase email domains allowed to sign in; empty = any member of the Claude org. */
  domains: string[];
  createdAt: number;
}

interface StoredBinding {
  v: 1;
  iss: string;
  owner: string;
  domains: string[];
  cred: string;
  at: number;
}

export type ManagedResult<T> = ({ ok: true } & T) | { ok: false; error: string };

const enc = new TextEncoder();

async function sha256hex(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function b64u(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64u(s: string): Uint8Array {
  const p = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(p + '='.repeat((4 - (p.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function aesKey(secret: string, tenantId: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest('SHA-256', enc.encode(`ema-seal:${secret}:${tenantId}`));
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function sealText(secret: string, tenantId: string, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(secret, tenantId), enc.encode(plaintext)));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return b64u(out);
}

async function openText(secret: string, tenantId: string, sealed: string): Promise<string | null> {
  try {
    const raw = unb64u(sealed);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, await aesKey(secret, tenantId), raw.slice(12));
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < Math.max(ab.length, bb.length); i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

/** Normalize an Issuer URL as pasted from Claude's dialog; null if it is not a Claude issuer. */
export function normalizeIssuer(input: string): string | null {
  const s = input.trim().replace(/\/+$/, '');
  return ISSUER_RE.test(s) ? s : null;
}

/** Parse "example.com, @example.org" into a clean list; null on an invalid entry. */
export function parseDomains(input: string): string[] | null {
  const parts = input
    .split(/[\s,;]+/)
    .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean);
  if (parts.length > 20 || parts.some((d) => !DOMAIN_RE.test(d))) return null;
  return [...new Set(parts)];
}

interface KeyStoreState {
  storage: { get<T>(key: string): Promise<T | undefined>; put<T>(key: string, value: T): Promise<void> };
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
}

/**
 * Durable Object that creates 32 random bytes the first time it is asked and returns the same
 * value forever after. Export it from the worker entry and bind it (wrangler: durable_objects
 * binding + a new_sqlite_classes migration). Never delete or rename it.
 */
export class EmaKeyStore {
  private key: string | undefined;
  constructor(state: KeyStoreState) {
    // Load or create before serving anything, so two first requests can't race.
    void state.blockConcurrencyWhile(async () => {
      let key = await state.storage.get<string>('ema-seal-key');
      if (!key) {
        key = b64u(crypto.getRandomValues(new Uint8Array(32)));
        await state.storage.put('ema-seal-key', key);
      }
      this.key = key;
    });
  }
  async fetch(): Promise<Response> {
    return this.key ? new Response(this.key, { headers: { 'Cache-Control': 'no-store' } }) : new Response('unavailable', { status: 503 });
  }
}

/** Fixed instance name: one key per deployment. Changing it voids every binding. */
const KEY_STORE_INSTANCE = 'ema-seal-key-v1';

export function createManagedAuth<C>(opts: ManagedAuthOptions<C>) {
  const P = opts.kvPrefix;
  const kvOf = (env: any): KVNamespace | undefined => (opts.kv ? opts.kv(env) : env?.OAUTH_KV);
  // Resolved per call (not captured at import), and never a bare stored fetch ("Illegal invocation").
  const doFetch: typeof fetch = (input, init) => (opts.fetchImpl ?? globalThis.fetch).call(globalThis, input, init);
  const tKey = (t: string) => `${P}ema:t:${t}`;
  const iKey = async (iss: string) => `${P}ema:i:${(await sha256hex(iss)).slice(0, 40)}`;
  const ownerOf = async (c: C) => sha256hex(`ema-owner:${P}${opts.credentialId(c)}`);

  function configuredSecret(env: any): string | undefined {
    const own = env?.[opts.sealSecretName];
    if (typeof own === 'string' && own) return own;
    for (const name of opts.fallbackSecretNames ?? []) {
      const v = env?.[name];
      if (typeof v === 'string' && v) return `derived:${name}:${v}`;
    }
    return undefined;
  }

  const keyStoreOf = (env: any): DurableObjectNamespace | undefined => (opts.generatedKeyBinding ? env?.[opts.generatedKeyBinding] : undefined);
  // The generated key never changes, so one lookup per isolate (per namespace) is enough.
  const generated = new WeakMap<object, Promise<string>>();

  async function sealSecret(env: any): Promise<string | undefined> {
    const s = configuredSecret(env);
    if (s) return s;
    const ns = keyStoreOf(env);
    if (!ns) return undefined;
    let p = generated.get(ns);
    if (!p) {
      p = (async () => {
        const res = await ns.get(ns.idFromName(KEY_STORE_INSTANCE)).fetch('https://ema-keys.internal/key');
        const key = res.ok ? await res.text() : '';
        if (key.length < 40) throw new Error(`managed-auth key store answered ${res.status}`);
        return `generated:${key}`;
      })();
      p.catch(() => generated.delete(ns)); // retry on the next request instead of caching a failure
      generated.set(ns, p);
    }
    try {
      return await p;
    } catch {
      return undefined;
    }
  }

  const enabled = (env: any) => !!kvOf(env) && (!!configuredSecret(env) || !!keyStoreOf(env));

  async function readIndex(kv: KVNamespace, iss: string): Promise<string[]> {
    try {
      const v = JSON.parse((await kv.get(await iKey(iss))) ?? '[]');
      return Array.isArray(v) ? v.filter((t) => typeof t === 'string' && TENANT_RE.test(t)) : [];
    } catch {
      return [];
    }
  }

  async function writeIndex(kv: KVNamespace, iss: string, tenants: string[]): Promise<void> {
    const k = await iKey(iss);
    if (tenants.length) await kv.put(k, JSON.stringify(tenants));
    else await kv.delete(k);
  }

  async function readBinding(kv: KVNamespace, tenantId: string): Promise<StoredBinding | null> {
    if (!TENANT_RE.test(tenantId)) return null;
    try {
      const v = JSON.parse((await kv.get(tKey(tenantId))) ?? 'null');
      return v && v.v === 1 && typeof v.iss === 'string' && typeof v.cred === 'string' ? v : null;
    } catch {
      return null;
    }
  }

  // Issuer metadata cache per isolate (the provider caches the JWKS itself).
  const metaCache = new Map<string, { jwksUri: string; until: number }>();

  /** Claude's issuer metadata: issuer must echo back exactly, jwks_uri must stay on Claude's host. */
  async function issuerJwks(iss: string): Promise<string | null> {
    const hit = metaCache.get(iss);
    if (hit && hit.until > Date.now()) return hit.jwksUri;
    try {
      const r = await doFetch(`${iss}/.well-known/openid-configuration`, { headers: { Accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(8000) });
      if (!r.ok) return null;
      const m = (await r.json()) as { issuer?: unknown; jwks_uri?: unknown };
      if (m.issuer !== iss || typeof m.jwks_uri !== 'string') return null;
      const u = new URL(m.jwks_uri);
      if (u.protocol !== 'https:' || u.hostname !== CLAUDE_ISSUER_HOST) return null;
      metaCache.set(iss, { jwksUri: u.href, until: Date.now() + 10 * 60_000 });
      return u.href;
    } catch {
      return null;
    }
  }

  /** Provider option, or undefined when managed auth is off (no KV or no seal secret). */
  function emaOptions(env: any): EmaOptions<any> | undefined {
    if (!enabled(env)) return undefined;
    return {
      allowPublicClients: true,
      trustedIssuers: async ({ iss, env: e }) => {
        const s = normalizeIssuer(iss);
        const kv = kvOf(e);
        if (!s || s !== iss || !kv) return null;
        // Only issuers an admin bound are ever fetched.
        if (!(await readIndex(kv, iss)).length) return null;
        const jwksUri = await issuerJwks(iss);
        return jwksUri ? { issuer: iss, jwksUri, algorithms: ['ES256'] } : null;
      },
      mapClaims: async ({ claims, env: e, requestedScope }) => {
        const kv = kvOf(e);
        const secret = await sealSecret(e);
        if (!kv || !secret) return null;
        const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
        if (!email || !email.includes('@')) return null;
        // Tenant: the one the admin pasted into Claude (aud_tenant), else the issuer's only binding.
        let tenantId: string | undefined;
        const audTenant = typeof claims.aud_tenant === 'string' ? claims.aud_tenant : undefined;
        if (audTenant) tenantId = audTenant;
        else {
          const all = await readIndex(kv, claims.iss);
          if (all.length !== 1) return null;
          tenantId = all[0];
        }
        const b = await readBinding(kv, tenantId);
        if (!b || b.iss !== claims.iss) return null;
        const domain = email.slice(email.lastIndexOf('@') + 1);
        if (b.domains.length && !b.domains.includes(domain)) return null;
        const pt = await openText(secret, tenantId, b.cred);
        if (!pt) return null;
        let credential: C;
        try {
          credential = JSON.parse(pt) as C;
        } catch {
          return null;
        }
        const allowed = opts.scopes ?? ['mcp'];
        const scope = requestedScope.filter((s) => allowed.includes(s));
        return {
          // No ':' allowed (provider token separator): a hash of tenant + email.
          userId: `ema-${(await sha256hex(`${tenantId}|${email}`)).slice(0, 40)}`,
          scope: scope.length ? scope : allowed,
          metadata: { managed: true, tenant: tenantId },
          props: opts.toProps(credential, email),
          accessTokenTTL: opts.accessTokenTTL ?? 3600,
        };
      },
    };
  }

  /**
   * Bind (or rebind) a Claude issuer to a credential. The caller has already checked the
   * credential works upstream. Pass `tenantId` to update an existing binding: only the same
   * credential (owner hash) may do that. Returns the Tenant ID to paste into Claude.
   */
  async function saveBinding(
    env: any,
    input: { issuer: string; credential: C; domains?: string[]; tenantId?: string; verifyIssuer?: boolean },
  ): Promise<ManagedResult<{ binding: Binding }>> {
    const kv = kvOf(env);
    const secret = await sealSecret(env);
    if (!kv || !secret) {
      return { ok: false, error: enabled(env) ? 'The server could not load its managed-authorization key. Try again in a minute.' : `Managed authorization is off on this server (${opts.sealSecretName} is not set).` };
    }
    const iss = normalizeIssuer(input.issuer);
    if (!iss) return { ok: false, error: `That is not a Claude Issuer URL. Copy it from Claude's "Managed authorization" dialog; it looks like https://${CLAUDE_ISSUER_HOST}/issuers/…` };
    if (input.verifyIssuer !== false && !(await issuerJwks(iss))) return { ok: false, error: 'Claude did not confirm that Issuer URL. Copy it again from the dialog.' };
    const owner = await ownerOf(input.credential);
    let tenantId = input.tenantId?.trim();
    let createdAt = Date.now();
    if (tenantId) {
      const old = await readBinding(kv, tenantId);
      if (!old) return { ok: false, error: 'No setup with that Tenant ID. Leave it empty to create a new one.' };
      if (!constantTimeEqual(old.owner, owner)) return { ok: false, error: 'That Tenant ID was set up with a different credential. Use the same one to change it.' };
      createdAt = old.at;
      if (old.iss !== iss) await writeIndex(kv, old.iss, (await readIndex(kv, old.iss)).filter((t) => t !== tenantId));
    } else {
      tenantId = `tn_${b64u(crypto.getRandomValues(new Uint8Array(18)))}`;
    }
    const stored: StoredBinding = {
      v: 1,
      iss,
      owner,
      domains: input.domains ?? [],
      cred: await sealText(secret, tenantId, JSON.stringify(input.credential)),
      at: createdAt,
    };
    await kv.put(tKey(tenantId), JSON.stringify(stored));
    const idx = await readIndex(kv, iss);
    if (!idx.includes(tenantId)) await writeIndex(kv, iss, [...idx, tenantId].slice(-50));
    return { ok: true, binding: { tenantId, issuer: iss, domains: stored.domains, createdAt } };
  }

  /** Remove a binding; members lose access on their next token (≤ accessTokenTTL). Same credential required. */
  async function removeBinding(env: any, tenantId: string, credential: C): Promise<ManagedResult<{}>> {
    const kv = kvOf(env);
    if (!kv) return { ok: false, error: 'Managed authorization is off on this server.' };
    const old = await readBinding(kv, tenantId.trim());
    if (!old) return { ok: false, error: 'No setup with that Tenant ID.' };
    if (!constantTimeEqual(old.owner, await ownerOf(credential))) return { ok: false, error: 'That Tenant ID was set up with a different credential.' };
    await kv.delete(tKey(tenantId.trim()));
    await writeIndex(kv, old.iss, (await readIndex(kv, old.iss)).filter((t) => t !== tenantId.trim()));
    return { ok: true };
  }

  /** For /health `warnings`. Names the missing setting, never a value. */
  function healthWarnings(env: any): string[] {
    if (!kvOf(env)) return [];
    if (enabled(env)) return [];
    return [
      opts.generatedKeyBinding
        ? `claude.ai managed authorization is off: bind the ${opts.generatedKeyBinding} Durable Object (EmaKeyStore) or set ${opts.sealSecretName} (members connect one by one).`
        : `${opts.sealSecretName} is not set: claude.ai managed authorization is off (members connect one by one).`,
    ];
  }

  return { enabled, emaOptions, saveBinding, removeBinding, healthWarnings };
}
