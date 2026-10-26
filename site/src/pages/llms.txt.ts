import type { APIRoute } from 'astro';
import { allDocs, ORIGIN, REPO, SITE, pagePath, twinPath } from '../lib/site';

export const GET: APIRoute = async () => {
  const docs = await allDocs();
  const lines = docs.map((d) => `- [${d.data.title}](${SITE}${twinPath(d.id)}): ${d.data.description}`);
  const body = `# Koinonia

> Open-source live-streaming studio in the browser with a Zig daemon, controlled by agents through WebMCP. Twitch and YouTube, no OBS. Pre-alpha: every component is labelled Built, In progress or Planned in the docs; treat Planned as not implemented.

Notes for agents:
- Each link below is the Markdown twin of an HTML page. Drop the .md suffix and add a trailing slash for the HTML version.
- The whole documentation in one file: ${ORIGIN}/llms-full.txt
- Landing summary: ${ORIGIN}/index.md
- Source repository: ${REPO}

## Docs

${lines.join('\n')}

## Optional

- [Landing summary](${ORIGIN}/index.md): what Koinonia is and implementation status.
- [Search index](${ORIGIN}/search-index.json): JSON of all pages for retrieval.
- [Sitemap](${ORIGIN}/sitemap-index.xml)
`;
  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
};
