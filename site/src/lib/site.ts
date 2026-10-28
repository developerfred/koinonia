import { getCollection, type CollectionEntry } from 'astro:content';
import { COMPONENTS, STATUS } from '../data/status.mjs';
import { TOOLS } from '../data/tools.mjs';

export const SITE = 'https://developerfred.github.io';
export const BASE = '/koinonia';
export const ORIGIN = SITE + BASE;
export const REPO = 'https://github.com/developerfred/koinonia';

export type Doc = CollectionEntry<'docs'>;

/** URL path (with base, trailing slash) of a docs entry. */
export const pagePath = (id: string) => `${BASE}/${id}/`;
/** Markdown twin path. */
export const twinPath = (id: string) => `${BASE}/${id === 'docs' ? 'docs/index' : id}.md`;
/** Route slug for the .md endpoint under /docs/. */
export const twinSlug = (id: string) => (id === 'docs' ? 'index' : id.replace(/^docs\//, ''));

export async function allDocs(): Promise<Doc[]> {
  const docs = await getCollection('docs');
  const rank = (d: Doc) => (d.id === 'docs' ? 0 : d.id === 'docs/status' ? 1 : d.id === 'docs/quickstart' ? 2 : 10);
  return docs.sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
}

/** Clean Markdown for agents: no SVG/figures, absolute links, title and description up top. */
export function toTwin(d: Doc): string {
  const url = ORIGIN.replace(BASE, '') + pagePath(d.id);
  let body = (d.body ?? '')
    .replace(/<figure[\s\S]*?<\/figure>\s*/g, '')
    .replace(/<!--dl-start-->[\s\S]*?<!--dl-end-->\s*/g, '')
    .replace(/^:::(\w+)(?:\[(.*?)\])?\s*$/gm, (_m, kind, title) => `> **${title ?? kind.toUpperCase()}**`)
    .replace(/^:::\s*$/gm, '')
    .replace(/\]\((?!https?:|#|mailto:|\/)([^)]+)\)/g, (_m, href) => `](${new URL(href, url).href})`)
    .replace(/\]\(\/(?!\/)([^)]+)\)/g, (_m, href) => `](${SITE}/${href})`)
    .trim();
  return `# ${d.data.title}\n\n> ${d.data.description}\n\nSource: ${url}\n\n${body}\n`;
}

export function landingTwin(): string {
  const rows = COMPONENTS.map((c) => `- ${c.name} (${c.where}): ${STATUS[c.status as keyof typeof STATUS].label}. ${c.note}`).join('\n');
  const tools = TOOLS.map((t) => `- \`${t.name}\`${t.sensitive ? ' (human-confirmed)' : ''}: ${t.summary}`).join('\n');
  return `# Koinonia

> Open-source live-streaming studio that runs in the browser, with a Zig daemon and WebMCP tools so agents can run the show. Twitch and YouTube, no OBS. Status: pre-alpha.

Docs: ${ORIGIN}/docs/
Download (alpha, unsigned): ${ORIGIN}/docs/download/
Source: ${REPO}
License: MIT

## What it is

The browser is the studio: capture, scene composition in a Worker, WebCodecs H.264/AAC. A Zig daemon (koinonia-d) receives encoded chunks over WebSocket and sends FLV over RTMPS to Twitch and YouTube in parallel, plus MPEG-TS into a clip buffer, with no re-encode. The studio page registers WebMCP tools through navigator.modelContext. A token-economy layer keeps agent cost low.

## Implementation status

${rows}

## Planned WebMCP tools

${tools}

## For agents

- ${ORIGIN}/llms.txt
- ${ORIGIN}/llms-full.txt
- Append .md to any docs URL.
`;
}
