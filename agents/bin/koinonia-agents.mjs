#!/usr/bin/env node
// Bundles src/cli.ts with esbuild on first use (or when stale), then runs it.
import { existsSync, statSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist", "cli.mjs");
const newest = (dir) =>
  readdirSync(dir, { withFileTypes: true }).reduce((m, e) => {
    const p = join(dir, e.name);
    return Math.max(m, e.isDirectory() ? newest(p) : statSync(p).mtimeMs);
  }, 0);
const stale = !existsSync(out) || Math.max(newest(join(root, "src")), newest(join(root, "..", "tokens", "src"))) > statSync(out).mtimeMs;
if (stale) {
  const { buildSync } = await import("esbuild");
  buildSync({ entryPoints: [join(root, "src", "cli.ts")], bundle: true, platform: "node", format: "esm", outfile: out, logLevel: "error" });
}
const { main } = await import(out);
process.exitCode = await main(process.argv.slice(2));
if (process.argv[2] !== "run") process.exit();
