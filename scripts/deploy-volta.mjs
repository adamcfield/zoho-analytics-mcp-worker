#!/usr/bin/env node
/**
 * Deploy a parallel copy of this worker to the Volta Cloudflare account.
 *
 * The committed wrangler config stays the source of truth (code, vars, DO migrations, rate
 * limits). `deploy/volta.jsonc` holds only what differs on the Volta account: its own KV
 * namespace ids, a custom domain, and which crons run there. This script merges the two into
 * a gitignored config NEXT TO the original (wrangler resolves `main` relative to the config
 * file) and deploys it with `wrangler deploy -c`.
 *
 *   node scripts/deploy-volta.mjs            generate + deploy every config in the overlay
 *   node scripts/deploy-volta.mjs --dry-run  generate + `wrangler deploy --dry-run`
 *   node scripts/deploy-volta.mjs --check    exit 0 = ready, 3 = overlay not filled in yet
 *   node scripts/deploy-volta.mjs --plan     print the `wrangler kv namespace create` commands
 *
 * The Volta account id is pinned in the overlay and overrides any `account_id` in the base
 * config, so the copy can never land on the personal account. Auth is whatever wrangler has
 * (an OAuth login that sees both accounts, or CLOUDFLARE_API_TOKEN in CI); a
 * CLOUDFLARE_ACCOUNT_ID that disagrees with the overlay is refused.
 *
 * Refuses to deploy when a KV/D1/R2 binding has no Volta value: binding a personal-account id
 * on another account fails at best, and a typo silently creates an empty namespace at worst.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const KV_ID_RE = /^[0-9a-f]{32}$/;
const D1_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NOT_READY = 3;

/** Strip // and /* *\/ comments and trailing commas from JSONC, leaving strings intact. */
export function stripJsonc(text) {
  let out = "";
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (inString) {
      out += c;
      if (c === "\\") { out += n ?? ""; i += 2; continue; }
      if (c === '"') inString = false;
      i++;
      continue;
    }
    if (c === '"') { inString = true; out += c; i++; continue; }
    if (c === "/" && n === "/") { while (i < text.length && text[i] !== "\n") i++; continue; }
    if (c === "/" && n === "*") { i += 2; while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++; i += 2; continue; }
    out += c;
    i++;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

export const parseJsonc = (text) => JSON.parse(stripJsonc(text));

/**
 * Merge one base config with its Volta overlay entry. Returns { config, missing }.
 * `missing` lists every value still to be filled in; a non-empty list means "do not deploy".
 */
export function voltaConfig(base, overlay, accountId) {
  const config = structuredClone(base);
  const missing = [];
  // Pin the Volta account explicitly: one wrangler login can see several accounts, and the base
  // config may pin the personal one.
  if (!/^[0-9a-f]{32}$/.test(String(accountId ?? ""))) missing.push("account_id");
  else config.account_id = accountId;
  delete config.env;
  delete config.route;

  // A custom domain, or explicitly the account's workers.dev subdomain (fallback when the zone
  // is not on the Volta account). One of the two, so the copy is never deployed unreachable.
  config.workers_dev = overlay.workers_dev ?? false;
  if (!overlay.domain && !config.workers_dev) missing.push("domain (or workers_dev: true)");
  config.routes = overlay.domain ? [{ pattern: overlay.domain, custom_domain: true }] : [];

  for (const ns of config.kv_namespaces ?? []) {
    const id = String(overlay.kv?.[ns.binding] ?? "").trim();
    delete ns.preview_id;
    if (!KV_ID_RE.test(id)) { missing.push(`kv.${ns.binding}`); continue; }
    ns.id = id;
  }
  for (const db of config.d1_databases ?? []) {
    const id = String(overlay.d1?.[db.binding] ?? "").trim();
    delete db.preview_database_id;
    if (!D1_ID_RE.test(id)) { missing.push(`d1.${db.binding}`); continue; }
    db.database_id = id;
  }
  for (const b of config.r2_buckets ?? []) {
    const name = String(overlay.r2?.[b.binding] ?? "").trim();
    if (!name) { missing.push(`r2.${b.binding}`); continue; }
    b.bucket_name = name;
  }

  if (Array.isArray(overlay.crons)) config.triggers = { ...(config.triggers ?? {}), crons: overlay.crons };
  if (overlay.vars) config.vars = { ...(config.vars ?? {}), ...overlay.vars };
  return { config, missing };
}

/** Path of the generated config: same directory as the base, so relative paths still resolve. */
export const outPath = (basePath) => join(dirname(basePath), `.volta.${basename(basePath).replace(/\.jsonc?$/, "")}.json`);

function main(argv) {
  const mode = argv.includes("--check") ? "check" : argv.includes("--plan") ? "plan" : argv.includes("--dry-run") ? "dry-run" : "deploy";
  const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
  const overlay = parseJsonc(readFileSync(join(root, "deploy/volta.jsonc"), "utf8"));
  const entries = Object.entries(overlay.configs ?? {});
  if (entries.length === 0) throw new Error("deploy/volta.jsonc has no configs");

  const built = entries.map(([file, entry]) => {
    const basePath = join(root, file);
    const base = parseJsonc(readFileSync(basePath, "utf8"));
    return { file, basePath, base, entry, ...voltaConfig(base, entry, overlay.account_id) };
  });

  if (mode === "plan") {
    // One namespace per binding name: configs in one repo that share a binding name (podio's
    // PODIO_TOKENS) share the namespace, exactly as on the personal account.
    const byBinding = new Map();
    for (const b of built) {
      for (const m of b.missing.filter((x) => x.startsWith("kv."))) {
        const binding = m.slice(3);
        if (!byBinding.has(binding)) byBinding.set(binding, { name: `${b.base.name}-${binding}`, files: [] });
        byBinding.get(binding).files.push(b.file);
      }
    }
    for (const [binding, { name, files }] of byBinding) {
      console.log(`npx wrangler kv namespace create ${name}   # -> kv.${binding} in ${files.join(", ")}`);
    }
    return 0;
  }

  const notReady = built.filter((b) => b.missing.length);
  if (notReady.length) {
    for (const b of notReady) console.log(`::notice::${b.file}: Volta overlay not filled in yet (${b.missing.join(", ")})`);
    return NOT_READY;
  }
  if (mode === "check") { console.log("Volta overlay complete"); return 0; }
  // CLOUDFLARE_ACCOUNT_ID beats the config's account_id in wrangler, so a mismatch would deploy
  // the copy somewhere else. Refuse it.
  const envAccount = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  if (envAccount && envAccount !== overlay.account_id) {
    throw new Error(`CLOUDFLARE_ACCOUNT_ID (${envAccount}) is not the Volta account in deploy/volta.jsonc (${overlay.account_id})`);
  }

  for (const b of built) {
    const out = outPath(b.basePath);
    writeFileSync(out, JSON.stringify(b.config, null, 2) + "\n");
    console.log(`${b.file} -> ${basename(out)}: ${b.config.name} on ${b.entry.domain ?? "workers.dev"}; crons ${JSON.stringify(b.config.triggers?.crons ?? [])}`);
    const args = ["wrangler", "deploy", "-c", out, ...(mode === "dry-run" ? ["--dry-run", "--outdir", join(root, ".volta-dist", b.config.name)] : [])];
    const r = spawnSync("npx", args, { stdio: "inherit", cwd: root, env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
    if (r.status !== 0) return r.status ?? 1;
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    console.error(`deploy-volta: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}
