import type { APIRoute } from 'astro';
import { allDocs, pagePath, toTwin, twinPath } from '../lib/site';

export const GET: APIRoute = async () => {
  const docs = await allDocs();
  const pages = docs.map((d) => ({
    path: pagePath(d.id),
    md: twinPath(d.id),
    title: d.data.title,
    description: d.data.description,
    text: toTwin(d),
  }));
  return new Response(JSON.stringify({ generated: 'build', pages }), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
};
