// WebMCP tools exposed by the docs site itself. Feature-detected: no-op without navigator.modelContext.
const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

interface Page { path: string; md: string; title: string; description: string; text: string }
let index: Promise<Page[]> | null = null;

export function loadIndex(): Promise<Page[]> {
  index ??= fetch(`${BASE}/search-index.json`).then((r) => r.json()).then((j) => j.pages as Page[]);
  return index;
}

export async function searchDocs(query: string, limit = 5) {
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
  const pages = await loadIndex();
  const scored = pages
    .map((p) => {
      const title = p.title.toLowerCase(), desc = p.description.toLowerCase(), text = p.text.toLowerCase();
      let score = 0, first = -1;
      for (const t of terms) {
        if (title.includes(t)) score += 10;
        if (desc.includes(t)) score += 4;
        const i = text.indexOf(t);
        if (i >= 0) { score += 1 + Math.min(text.split(t).length - 1, 5) * 0.3; if (first < 0 || i < first) first = i; }
      }
      const snippet = first >= 0 ? p.text.slice(Math.max(0, first - 60), first + 140).replace(/\s+/g, ' ').trim() : '';
      return { path: p.path, title: p.title, description: p.description, snippet, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.min(Math.max(limit, 1), 10));
  return scored.map(({ score: _s, ...r }) => r);
}

export async function getPage(path: string): Promise<string | null> {
  const pages = await loadIndex();
  const norm = (s: string) => s.replace(/^https?:\/\/[^/]+/, '').replace(BASE, '').replace(/\.md$/, '').replace(/\/?$/, '/').replace(/^\/?/, '/');
  const want = norm(path === '/' || path === '' ? '/docs/' : path);
  const hit = pages.find((p) => norm(p.path) === want || norm(p.md) === want);
  return hit ? hit.text : null;
}

export async function listPages() {
  return (await loadIndex()).map((p) => ({ path: p.path, title: p.title, description: p.description }));
}

const text = (v: unknown) => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v) }] });

export function registerDocsTools(): 'registered' | 'unsupported' | 'error' {
  const mc = (navigator as any).modelContext;
  if (!mc) return 'unsupported';
  const tools = [
    {
      name: 'search_docs',
      description: 'Search the Koinonia documentation. Returns ranked pages with a snippet. Follow with get_page.',
      inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 10, default: 5 } }, additionalProperties: false },
      annotations: { readOnlyHint: true },
      execute: async (a: { query: string; limit?: number }) => text(await searchDocs(a.query, a.limit)),
    },
    {
      name: 'get_page',
      description: 'Fetch one documentation page as Markdown. path is like /koinonia/docs/security/ or /docs/security/.',
      inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } }, additionalProperties: false },
      annotations: { readOnlyHint: true },
      execute: async (a: { path: string }) => text((await getPage(a.path)) ?? { error: { code: 'not_found', message: 'Use list_pages or search_docs for valid paths.' } }),
    },
    {
      name: 'list_pages',
      description: 'List every documentation page with title and description.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
      execute: async () => text(await listPages()),
    },
  ];
  try {
    if (typeof mc.registerTool === 'function') {
      for (const t of tools) { try { mc.registerTool(t); } catch { /* already registered */ } }
    } else if (typeof mc.provideContext === 'function') {
      mc.provideContext({ tools });
    } else return 'unsupported';
    document.documentElement.dataset.webmcp = 'registered';
    return 'registered';
  } catch (e) {
    console.debug('[koinonia] WebMCP registration failed', e);
    return 'error';
  }
}

if (typeof window !== 'undefined') {
  registerDocsTools();
}
