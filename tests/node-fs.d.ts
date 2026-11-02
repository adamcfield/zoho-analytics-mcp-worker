// Minimal typing for the one Node API the tests use; the project typechecks
// against Workers types only (no @types/node), so src/ can't accidentally use Node APIs.
declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
}
