// Placeholder for post-build steps (kept so `npm run build` has a single hook).
import { existsSync } from 'node:fs';
for (const f of ['dist/index.html', 'dist/llms.txt', 'dist/llms-full.txt', 'dist/search-index.json', 'dist/index.md']) {
  if (!existsSync(new URL('../' + f, import.meta.url))) { console.error('postbuild: missing', f); process.exit(1); }
}
console.log('postbuild: required artifacts present');
