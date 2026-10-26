import type { APIRoute } from 'astro';
import { allDocs, landingTwin, toTwin, ORIGIN } from '../lib/site';

export const GET: APIRoute = async () => {
  const docs = await allDocs();
  const parts = [landingTwin(), ...docs.map(toTwin)];
  const body = `<!-- Koinonia documentation, full text. Generated at build from ${ORIGIN}/ -->\n\n` + parts.join('\n\n---\n\n');
  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
};
