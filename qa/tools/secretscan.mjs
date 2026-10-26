#!/usr/bin/env node
// Dependency-free secret scanner: fallback when `gitleaks` is not installed locally (CI always runs real gitleaks).
// Scans tracked-looking text files under the repo for high-signal credential patterns. Exit 1 on findings.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(new URL("../..", import.meta.url).pathname);
const SKIP_DIR = new Set(["node_modules", ".git", ".zig-cache", "zig-cache", "zig-out", "dist", ".out", "coverage", "playwright-report", "test-results", ".astro"]);
const SKIP_FILE = /(package-lock\.json|\.png|\.jpg|\.ico|\.woff2?|\.zip|\.o)$/;
const ALLOW_PATH = /^qa\/(fixtures|security)\//; // deliberately fake keys live here
const RULES = [
  ["private key block", /-----BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/],
  ["AWS access key id", /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ["Anthropic/OpenAI style API key", /\bsk-(ant-)?[A-Za-z0-9_-]{32,}\b/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ["Twitch stream key", /\blive_\d{6,}_[A-Za-z0-9]{20,}\b/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["generic assignment of a long secret", /\b(?:api[_-]?key|secret|token|passwd|password|stream[_-]?key)\b["']?\s*[:=]\s*["'][A-Za-z0-9/+_-]{24,}["']/i],
];
const files = [];
const walk = (d) => { for (const n of readdirSync(d)) { if (SKIP_DIR.has(n)) continue; const p = join(d, n); const s = statSync(p); if (s.isDirectory()) walk(p); else if (s.size < 2e6 && !SKIP_FILE.test(n)) files.push(p); } };
walk(ROOT);
let bad = 0;
for (const f of files) {
  const rel = relative(ROOT, f);
  if (ALLOW_PATH.test(rel)) continue;
  let text; try { text = readFileSync(f, "utf8"); } catch { continue; }
  if (text.includes("\u0000")) continue;
  text.split("\n").forEach((line, i) => {
    if (/gitleaks:allow/.test(line)) return;
    for (const [name, re] of RULES) if (re.test(line)) { console.log(`${rel}:${i + 1}: ${name}`); bad++; }
  });
}
console.log(`secretscan: ${files.length} files, ${bad} finding(s)`);
process.exit(bad ? 1 : 0);
