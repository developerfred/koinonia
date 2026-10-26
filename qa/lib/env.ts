import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const QA = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const ROOT = resolve(QA, "..");
export const P = {
  daemon: join(ROOT, "daemon"),
  studio: join(ROOT, "studio"),
  tokens: join(ROOT, "tokens"),
  site: join(ROOT, "site"),
  fixtures: join(QA, "fixtures"),
  // Prefer the QA-owned build (qa/.out/daemon, produced by `make daemon-build`, never touches daemon/zig-out), then the dev build.
  daemonBin: process.env.KOINONIA_D_BIN ?? [join(QA, ".out", "daemon", "bin", "koinonia-d"), join(ROOT, "daemon", "zig-out", "bin", "koinonia-d")].find((p) => existsSync(p)) ?? join(QA, ".out", "daemon", "bin", "koinonia-d"),
};

export const readJson = <T = any>(p: string): T => JSON.parse(readFileSync(p, "utf8"));
export const fixture = <T = any>(rel: string): T => readJson<T>(join(P.fixtures, rel));

/** Component readiness probes. Tests use these to skip (with a reason) instead of failing on missing components. */
export const ready = {
  daemonSources: () => existsSync(join(P.daemon, "src", "framing.zig")),
  daemonBin: () => existsSync(P.daemonBin),
  protocolMd: () => existsSync(join(P.daemon, "PROTOCOL.md")),
  studioMain: () => existsSync(join(P.studio, "src", "main.ts")),
  studioModules: () => existsSync(join(P.studio, "node_modules")),
  tokensIndex: () => existsSync(join(P.tokens, "src", "index.ts")),
  tokensSrc: (f: string) => existsSync(join(P.tokens, "src", f)),
  site: () => existsSync(join(P.site, "package.json")) && existsSync(join(P.site, "node_modules")),
  siteDist: () => existsSync(join(P.site, "dist")),
};

export function listFiles(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".") || e.name === "zig-out") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p, exts));
    else if (exts.some((x) => e.name.endsWith(x))) out.push(p);
  }
  return out;
}
