// Verifies internal links, assets and #anchors in dist/. Exit 1 on any broken reference.
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

const DIST = resolve(new URL('../dist', import.meta.url).pathname);
const BASE = '/koinonia';
const ORIGIN = 'https://developerfred.github.io';
const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const htmls = walk(DIST).filter((f) => f.endsWith('.html') && !f.endsWith('404.html'));
const idCache = new Map();
const ids = (file) => {
  if (!idCache.has(file)) idCache.set(file, new Set([...readFileSync(file, 'utf8').matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])));
  return idCache.get(file);
};
const resolveFile = (pathname) => {
  const rel = decodeURIComponent(pathname.slice(BASE.length)) || '/';
  const cands = [join(DIST, rel), join(DIST, rel, 'index.html'), join(DIST, rel + '.html')];
  return cands.find((c) => existsSync(c) && statSync(c).isFile());
};
let bad = 0, checked = 0;
for (const file of htmls) {
  const html = readFileSync(file, 'utf8');
  const pageUrl = BASE + '/' + file.slice(DIST.length + 1).replace(/index\.html$/, '');
  for (const m of html.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
    let u = m[1];
    if (/^(mailto:|tel:|data:|javascript:)/.test(u)) continue;
    if (u.startsWith(ORIGIN)) u = u.slice(ORIGIN.length);
    else if (/^[a-z]+:|^\/\//.test(u)) continue;
    let url;
    try { url = new URL(u, 'http://x' + pageUrl); } catch { continue; }
    checked++;
    if (!url.pathname.startsWith(BASE + '/') && url.pathname !== BASE) { console.log(`[outside base] ${pageUrl} -> ${u}`); bad++; continue; }
    const target = resolveFile(url.pathname === BASE ? BASE + '/' : url.pathname);
    if (!target) { console.log(`[missing] ${pageUrl} -> ${u}`); bad++; continue; }
    if (url.hash && target.endsWith('.html') && !ids(target).has(decodeURIComponent(url.hash.slice(1)))) { console.log(`[anchor] ${pageUrl} -> ${u}`); bad++; }
  }
}
console.log(`check-links: ${htmls.length} pages, ${checked} references, ${bad} problems`);
process.exit(bad ? 1 : 0);
