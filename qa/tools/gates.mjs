#!/usr/bin/env node
// `make qa` driver: runs every quality gate, never aborts early, prints PASS / FAIL / SKIP (with reason) per gate.
//   node qa/tools/gates.mjs                 run everything
//   node qa/tools/gates.mjs --only a,b      run gates by id            --group daemon|studio|...  run one group
//   node qa/tools/gates.mjs --fast          skip slow gates (e2e, soak, site, audit)
//   node qa/tools/gates.mjs --list
// Env: QA_STRICT=1 turns SKIP into FAIL (CI);  QA_NO_INSTALL=1 never installs deps;  QA_SITE_BUILD=1 rebuild site first.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, createWriteStream } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(new URL("../..", import.meta.url).pathname);
const QA = join(ROOT, "qa");
const OUT = join(QA, ".out");
const LOGS = join(OUT, "logs");
mkdirSync(LOGS, { recursive: true });
const bin = (p, n) => join(p, "node_modules", ".bin", n);
const has = (...p) => existsSync(join(ROOT, ...p));
const pkg = (dir) => (has(dir, "package.json") ? JSON.parse(readFileSync(join(ROOT, dir, "package.json"), "utf8")) : null);
const thresholds = JSON.parse(readFileSync(join(QA, "coverage-thresholds.json"), "utf8"));
const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const strict = !!process.env.QA_STRICT;
const zigCache = ["--cache-dir", join(OUT, "zig-cache")];

const needNodeModules = (dir) => (has(dir, "node_modules") ? null : `${dir}/node_modules missing (run: make install)`);
const needScript = (dir, s) => (pkg(dir)?.scripts?.[s] ? null : `${dir}/package.json has no "${s}" script`);
const first = (...r) => r.find(Boolean) ?? null;
const qaReady = () => needNodeModules("qa");
const vitestQa = (...a) => ({ cmd: bin(QA, "vitest"), args: ["run", "--root", QA, ...a], cwd: QA });

/** Coverage for a TS package: uses the package's own vitest + qa's coverage-v8 provider (installed --no-save into the package on demand). */
function covGate(dir) {
  const t = thresholds[dir];
  return {
    id: `${dir}:test`, group: dir,
    skip: () => first(needNodeModules(dir), needScript(dir, "test"), !has(dir, "test") && !has(dir, "src") ? `${dir}/test missing` : null),
    prep: async () => {
      if (!existsSync(join(ROOT, dir, "node_modules", "@vitest", "coverage-v8")) && !process.env.QA_NO_INSTALL)
        await sh("npm", ["install", "--no-save", "--no-audit", "--no-fund", "--no-package-lock", "@vitest/coverage-v8@2.1.9"], join(ROOT, dir), `${dir}-covinstall`);
    },
    cmd: bin(join(ROOT, dir), "vitest"),
    args: () => ["run", "--coverage.enabled", "--coverage.provider=v8", "--coverage.reporter=text-summary", "--coverage.reporter=json-summary",
      `--coverage.reportsDirectory=${join(OUT, "coverage", dir)}`, "--coverage.include=src/**", ...(t.exclude ?? []).map((e) => `--coverage.exclude=${e}`),
      ...["lines", "statements", "functions", "branches"].map((k) => `--coverage.thresholds.${k}=${t[k]}`)],
    cwd: join(ROOT, dir), slow: false,
  };
}
const tsGates = (dir) => [
  { id: `${dir}:typecheck`, group: dir, skip: () => first(needNodeModules(dir), needScript(dir, "typecheck")), cmd: "npm", args: ["--prefix", join(ROOT, dir), "run", "-s", "typecheck"] },
  covGate(dir),
];

const gates = [
  { id: "qa:install", group: "qa", skip: () => null, run: async () => { if (existsSync(join(QA, "node_modules")) || process.env.QA_NO_INSTALL) return 0; return sh("npm", ["ci", "--no-audit", "--no-fund"], QA, "qa-install"); } },
  { id: "qa:selftest-tooling", group: "qa", skip: qaReady, cmd: "npx", args: ["--no-install", "tsc", "--noEmit"], cwd: QA },
  { id: "qa:fixtures-fresh", group: "qa", skip: () => null, cmd: "node", args: [join(QA, "tools", "gen-fixtures.mjs"), "--check"] },

  // ---- daemon (Zig)
  { id: "daemon:fmt", group: "daemon", skip: () => (has("daemon", "build.zig") ? null : "daemon/build.zig missing"), cmd: "zig", args: ["fmt", "--check", "src", "build.zig", "build.zig.zon"], cwd: join(ROOT, "daemon") },
  { id: "daemon:test", group: "daemon", skip: () => (has("daemon", "build.zig") ? null : "daemon/build.zig missing"), cmd: "zig", args: ["build", "test", "--summary", "all", ...zigCache, "--prefix", join(OUT, "daemon")], cwd: join(ROOT, "daemon") },
  { id: "daemon:build", group: "daemon", skip: () => (has("daemon", "build.zig") ? null : "daemon/build.zig missing"), cmd: "zig", args: ["build", ...zigCache, "--prefix", join(OUT, "daemon")], cwd: join(ROOT, "daemon") },
  { id: "daemon:build-releasesafe", group: "daemon", slow: true, skip: () => (has("daemon", "build.zig") ? null : "daemon/build.zig missing"), cmd: "zig", args: ["build", "-Doptimize=ReleaseSafe", ...zigCache, "--prefix", join(OUT, "daemon-rs")], cwd: join(ROOT, "daemon") },

  // ---- TS components
  ...tsGates("studio"),
  { id: "studio:build", group: "studio", slow: true, skip: () => first(needNodeModules("studio"), has("studio", "src", "main.ts") ? null : "studio/src/main.ts missing"), cmd: bin(join(ROOT, "studio"), "vite"), args: ["build", "--outDir", join(OUT, "studio-dist"), "--emptyOutDir"], cwd: join(ROOT, "studio") },
  ...tsGates("tokens"),
  ...(has("agents", "package.json") ? tsGates("agents") : []),
  { id: "lint:ts", group: "lint", skip: qaReady, cmd: bin(QA, "eslint"), args: ["-c", "qa/eslint.config.js", ...["studio/src", "tokens/src", "agents/src", "qa/lib", "qa/contract", "qa/integration", "qa/security", "qa/fuzz", "qa/properties", "qa/evals", "qa/e2e", "qa/soak", "qa/tools"].filter((p) => has(p))], cwd: ROOT },

  // ---- qa suites
  { id: "qa:zig-conformance+fuzz", group: "qa", skip: () => first(has("daemon", "src", "root.zig") ? null : "daemon/src/root.zig missing"), cmd: "zig", args: ["build", "test", "--summary", "all", "-Dfuzz-iters=" + (process.env.QA_ZIG_FUZZ_ITERS ?? "100000"), "--cache-dir", join(OUT, "zig-cache-qa")], cwd: join(QA, "zig") },
  { id: "contract", group: "qa", skip: qaReady, ...vitestQa("contract") },
  { id: "integration", group: "qa", skip: () => first(qaReady(), daemonBinMissing()), ...vitestQa("integration"), needsDaemon: true },
  { id: "security:tests", group: "security", skip: () => first(qaReady(), daemonBinMissing()), ...vitestQa("security"), needsDaemon: true },
  { id: "fuzz", group: "qa", skip: () => first(qaReady(), daemonBinMissing()), ...vitestQa("fuzz"), needsDaemon: true },
  { id: "properties", group: "qa", skip: qaReady, ...vitestQa("properties") },
  { id: "evals:token-economy", group: "qa", skip: () => first(qaReady(), has("tokens", "src", "chat.ts") ? null : "tokens not ready"), ...vitestQa("evals") },
  { id: "e2e:playwright", group: "e2e", slow: true, skip: () => first(qaReady(), needNodeModules("studio"), has("studio", "src", "main.ts") ? null : "studio/src/main.ts missing", chromiumMissing()), cmd: bin(QA, "playwright"), args: ["test"], cwd: QA },
  { id: "soak:smoke", group: "qa", slow: true, skip: () => first(qaReady(), daemonBinMissing()), cmd: bin(QA, "tsx"), args: ["soak/soak.ts", "--profile", "smoke"], cwd: QA, needsDaemon: true },

  // ---- security
  { id: "security:secrets", group: "security", skip: () => null, run: async () => ((await which("gitleaks")) ? sh("gitleaks", ["detect", "--no-banner", "--redact", "-c", join(ROOT, ".gitleaks.toml"), "--no-git", "--source", ROOT], ROOT, "gitleaks") : sh("node", [join(QA, "tools", "secretscan.mjs")], ROOT, "secretscan-fallback")), note: async () => ((await which("gitleaks")) ? "gitleaks" : "gitleaks not installed: ran built-in fallback scanner (CI runs real gitleaks)") },
  { id: "security:audit", group: "security", slow: true, skip: () => (process.env.QA_OFFLINE ? "QA_OFFLINE=1" : null), run: auditAll },
  { id: "security:zig-deps", group: "security", skip: () => (has("daemon", "build.zig.zon") ? null : "no build.zig.zon"), run: async () => { const z = readFileSync(join(ROOT, "daemon", "build.zig.zon"), "utf8"); const m = /\.dependencies\s*=\s*\.\{([\s\S]*?)\n\s*\},/.exec(z); const deps = (m?.[1] ?? "").replace(/\/\/.*$/gm, "").trim(); console.log(deps ? `zig dependencies declared:\n${deps}\n(pin hashes; review manually)` : "daemon has zero third-party Zig dependencies"); return 0; } },

  // ---- site
  { id: "site:build", group: "site", slow: true, skip: () => first(has("site", "package.json") ? null : "site/ missing", needNodeModules("site")), run: async () => (process.env.QA_SITE_BUILD || !has("site", "dist") ? sh("npm", ["--prefix", join(ROOT, "site"), "run", "build"], ROOT, "site-build") : (console.log("reusing existing site/dist (QA_SITE_BUILD=1 to rebuild)"), 0)) },
  { id: "site:quality", group: "site", slow: true, skip: () => first(qaReady(), has("site", "dist") ? null : "site/dist missing (site:build failed or not run)"), cmd: bin(QA, "tsx"), args: ["tools/site-gate.ts"], cwd: QA },
];

function daemonBinMissing() {
  const cands = [process.env.KOINONIA_D_BIN, join(OUT, "daemon", "bin", "koinonia-d"), join(ROOT, "daemon", "zig-out", "bin", "koinonia-d")].filter(Boolean);
  return cands.some(existsSync) ? null : "daemon binary not built (daemon:build gate / make daemon-build)";
}
function chromiumMissing() {
  const home = process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(process.env.HOME ?? "", process.platform === "darwin" ? "Library/Caches/ms-playwright" : ".cache/ms-playwright");
  return existsSync(home) ? null : "Playwright Chromium not installed (run: make install)";
}

function sh(cmd, argv, cwd, logId, env = {}) {
  return new Promise((res) => {
    const log = createWriteStream(join(LOGS, `${logId}.log`), { flags: "w" });
    const p = spawn(cmd, argv, { cwd, env: { ...process.env, FORCE_COLOR: "0", ...env }, stdio: ["ignore", "pipe", "pipe"] });
    p.stdout.on("data", (d) => log.write(d)); p.stderr.on("data", (d) => log.write(d));
    p.on("error", (e) => { log.write(String(e)); res(127); });
    p.on("close", (c) => { log.end(); res(c ?? 1); });
  });
}
const which = async (c) => (await sh("sh", ["-c", `command -v ${c}`], ROOT, "which")) === 0;

async function auditAll() {
  // Policy: HIGH/CRITICAL advisories in *production* dependencies fail the gate. Dev-tooling advisories (vitest/vite/esbuild/happy-dom)
  // are reported but only fail with QA_AUDIT_DEV=1, because they never ship and the fix is a breaking toolchain upgrade.
  let worst = 0; let net = 0;
  for (const d of ["qa", "studio", "tokens", "agents", "site", "desktop"]) {
    if (!has(d, "package-lock.json")) { console.log(`${d}: no package-lock.json (skipped)`); continue; }
    const cwd = join(ROOT, d);
    const prod = await sh("npm", ["audit", "--audit-level=high", "--omit=dev", "--package-lock-only"], cwd, `audit-${d}-prod`);
    const prodOut = readFileSync(join(LOGS, `audit-${d}-prod.log`), "utf8");
    if (prod !== 0 && /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|network/i.test(prodOut)) { console.log(`${d}: audit endpoint unreachable (offline)`); net++; continue; }
    const all = await sh("npm", ["audit", "--audit-level=high", "--package-lock-only"], cwd, `audit-${d}-all`);
    const summary = /(\d+ vulnerabilit[^\n]*)/.exec(readFileSync(join(LOGS, `audit-${d}-all.log`), "utf8"))?.[1] ?? "none";
    console.log(`${d}: production deps ${prod === 0 ? "clean (no high/critical)" : "HIGH/CRITICAL FOUND"}; all deps incl. dev tooling: ${all === 0 ? "clean" : summary + " (dev-only, see logs/audit-" + d + "-all.log)"}`);
    if (prod !== 0 || (all !== 0 && process.env.QA_AUDIT_DEV)) worst = 1;
  }
  return worst || (net ? 125 : 0); // 125 => SKIP (offline)
}

// ---------------------------------------------------------------- runner
if (flag("list")) { for (const g of gates) console.log(`${g.id.padEnd(28)} ${g.group}${g.slow ? " (slow)" : ""}`); process.exit(0); }
const only = opt("only")?.split(",");
const group = opt("group");
const results = [];
const useColor = process.stdout.isTTY;
const c = (n, s) => (useColor ? `\x1b[${n}m${s}\x1b[0m` : s);

for (const g of gates) {
  if (only && !only.includes(g.id)) continue;
  if (group && g.group !== group) continue;
  if (flag("fast") && g.slow) { results.push({ id: g.id, status: "SKIP", why: "--fast" }); continue; }
  const why = g.skip?.();
  if (why) { results.push({ id: g.id, status: "SKIP", why }); console.log(`${c(33, "SKIP")} ${g.id}  (${why})`); continue; }
  const t0 = Date.now();
  if (useColor) process.stdout.write(`...... ${g.id}\r`);
  let code;
  try {
    if (g.prep) await g.prep();
    if (g.run) code = await g.run();
    else code = await sh(g.cmd, typeof g.args === "function" ? g.args() : g.args, g.cwd ?? ROOT, g.id.replace(/[:+]/g, "_"));
  } catch (e) { console.error(e); code = 1; }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const logFile = join(LOGS, `${g.id.replace(/[:+]/g, "_")}.log`);
  let note = g.note ? await g.note() : "";
  const tail = () => { try { return readFileSync(logFile, "utf8").trim().split("\n").slice(-25).join("\n"); } catch { return ""; } };
  // soak/integration print "[qa] SKIP ..." when they probe the daemon and it does not run yet; surface that instead of a false PASS.
  let skipped = "";
  if (code === 0 && g.needsDaemon) { const out = (() => { try { return readFileSync(logFile, "utf8"); } catch { return ""; } })(); const m = /\[(?:qa|soak)\] SKIP[^\n]*|\[soak\] SKIPPED[^\n]*/.exec(out); if (m) skipped = m[0]; }
  if (code === 125) { results.push({ id: g.id, status: "SKIP", why: "offline" }); console.log(`${c(33, "SKIP")} ${g.id}  (offline)`); continue; }
  if (skipped) { results.push({ id: g.id, status: "SKIP", why: skipped }); console.log(`${c(33, "SKIP")} ${g.id}  (${skipped})`); continue; }
  if (code === 0) { results.push({ id: g.id, status: "PASS", secs, note }); console.log(`${c(32, "PASS")} ${g.id}  ${secs}s${note ? "  - " + note : ""}`); }
  else { results.push({ id: g.id, status: "FAIL", secs }); console.log(`${c(31, "FAIL")} ${g.id}  ${secs}s  (exit ${code}; full log: qa/.out/logs/${g.id.replace(/[:+]/g, "_")}.log)\n${tail().replace(/^/gm, "    | ")}`); }
}

const count = (s) => results.filter((r) => r.status === s).length;
const skipsAsFail = strict ? count("SKIP") : 0;
console.log(`\n== qa summary: ${c(32, count("PASS") + " passed")}, ${c(31, count("FAIL") + " failed")}, ${c(33, count("SKIP") + " skipped")}${strict ? " (QA_STRICT: skips count as failures)" : ""}`);
for (const r of results.filter((x) => x.status === "SKIP")) console.log(`   skipped ${r.id}: ${r.why}`);
mkdirSync(OUT, { recursive: true });
import("node:fs").then(({ writeFileSync }) => writeFileSync(join(OUT, "gates.json"), JSON.stringify(results, null, 2)));
process.exit(count("FAIL") || skipsAsFail ? 1 : 0);
