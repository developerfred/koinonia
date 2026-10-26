#!/usr/bin/env tsx
// Site quality gate over site/dist (built by `npm --prefix site run build`):
//   1. structural checks (lang, <title>, one <h1>, meta description, no empty links)
//   2. internal link/anchor check (re-uses site/scripts/check-links.mjs when present)
//   3. axe-core WCAG 2.x A/AA on every page (Chromium via Playwright), light + dark color scheme
//   4. optional Lighthouse (QA_LIGHTHOUSE=1): perf/a11y/best-practices/seo thresholds
// The dist is served under the site's `base` (read from astro.config.mjs, default /koinonia) so absolute links resolve.
import http from "node:http";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { chromium } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const SITE = resolve(import.meta.dirname, "..", "..", "site");
const DIST = join(SITE, "dist");
if (!existsSync(join(SITE, "package.json")) || !existsSync(DIST)) {
  console.log("[site] SKIPPED: site/ not built (run: make site-build)"); process.exit(process.env.QA_REQUIRE_SITE ? 1 : 0);
}
const base = (/base:\s*['"]([^'"]*)['"]/.exec(readFileSync(join(SITE, "astro.config.mjs"), "utf8"))?.[1] ?? "").replace(/\/$/, "");
const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const pages = walk(DIST).filter((f) => f.endsWith(".html") && !f.endsWith("404.html"));
const failures: string[] = [];
const fail = (m: string) => { failures.push(m); console.log("FAIL " + m); };

// 1. structure
for (const f of pages) {
  const html = readFileSync(f, "utf8"); const rel = f.slice(DIST.length);
  if (!/<html[^>]*\slang="[a-zA-Z-]+"/.test(html)) fail(`${rel}: missing <html lang>`);
  if (!/<title>[^<]{2,}<\/title>/.test(html)) fail(`${rel}: missing/empty <title>`);
  const h1 = (html.match(/<h1[\s>]/g) ?? []).length; if (h1 !== 1) fail(`${rel}: expected exactly one <h1>, found ${h1}`);
  if (!/<meta[^>]+name="description"[^>]+content="[^"]{10,}"/.test(html)) fail(`${rel}: missing meta description`);
  if (/<a[^>]*href="#?"[^>]*>/.test(html)) fail(`${rel}: link with empty href`);
}
console.log(`[site] structure: ${pages.length} pages checked`);

// 2. links
const own = join(SITE, "scripts", "check-links.mjs");
if (existsSync(own)) { const r = spawnSync("node", [own], { cwd: SITE, encoding: "utf8" }); console.log(r.stdout.trim().split("\n").slice(-6).join("\n")); if (r.status !== 0) fail("site link check (site/scripts/check-links.mjs) reported broken references"); }
else console.log("[site] link check: site/scripts/check-links.mjs missing, skipped (gap)");

// 3. axe (serve dist under base)
const mime: Record<string, string> = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png", ".txt": "text/plain", ".json": "application/json", ".woff2": "font/woff2", ".xml": "application/xml" };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent((req.url ?? "/").split("?")[0]!); if (base && p.startsWith(base)) p = p.slice(base.length) || "/";
  let f = join(DIST, p); if (existsSync(f) && statSync(f).isDirectory()) f = join(f, "index.html");
  if (!existsSync(f)) { res.writeHead(404).end("nf"); return; }
  res.writeHead(200, { "content-type": mime[extname(f)] ?? "application/octet-stream" }).end(readFileSync(f));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as import("node:net").AddressInfo).port;
const urls = pages.map((f) => `http://127.0.0.1:${port}${base}${f.slice(DIST.length).replace(/index\.html$/, "")}`);
const browser = await chromium.launch();
try {
  for (const scheme of ["light", "dark"] as const) {
    const ctx = await browser.newContext({ colorScheme: scheme });
    for (const u of urls) {
      const page = await ctx.newPage();
      await page.goto(u, { waitUntil: "load" });
      const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"]).analyze();
      for (const v of r.violations.filter((x) => x.impact === "critical" || x.impact === "serious" || process.env.QA_AXE_STRICT)) fail(`axe[${scheme}] ${u.replace(/^http:\/\/127\.0\.0\.1:\d+/, "")}: ${v.id} (${v.impact}) x${v.nodes.length} [${v.nodes[0]?.target.join(" ")}] ${v.help}`);
      await page.close();
    }
    await ctx.close();
    console.log(`[site] axe ${scheme}: ${urls.length} pages scanned`);
  }
} finally { await browser.close(); }

// 4. Lighthouse (opt-in: slow, needs the lighthouse package via npx)
if (process.env.QA_LIGHTHOUSE) {
  const th = { performance: 0.85, accessibility: 0.95, "best-practices": 0.9, seo: 0.9 } as Record<string, number>;
  for (const u of urls.slice(0, 3)) {
    try {
      const out = execFileSync("npx", ["--yes", "lighthouse@12.2.1", u, "--output=json", "--quiet", "--chrome-flags=--headless=new --no-sandbox", `--chrome-path=${chromium.executablePath()}`], { encoding: "utf8", maxBuffer: 64e6 });
      const cats = JSON.parse(out).categories as Record<string, { score: number }>;
      for (const [k, min] of Object.entries(th)) { const s = cats[k]?.score ?? 0; console.log(`[lighthouse] ${u.replace(/^http:\/\/127\.0\.0\.1:\d+/, "")} ${k}=${s}`); if (s < min) fail(`lighthouse ${k} ${s} < ${min} on ${u}`); }
    } catch (e) { fail(`lighthouse run failed: ${(e as Error).message.slice(0, 200)}`); }
  }
} else console.log("[site] lighthouse: skipped locally (QA_LIGHTHOUSE=1 to enable; always on in CI)");
server.close();
if (failures.length) { console.error(`[site] ${failures.length} problem(s)`); process.exit(1); }
console.log("[site] OK");
