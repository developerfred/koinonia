import type { APIRoute, GetStaticPaths } from 'astro';
import { allDocs, toTwin, twinSlug } from '../../lib/site';

export const getStaticPaths = (async () => {
  const docs = await allDocs();
  return docs.map((d) => ({ params: { slug: twinSlug(d.id) }, props: { text: toTwin(d) } }));
}) satisfies GetStaticPaths;

export const GET: APIRoute = ({ props }) =>
  new Response(props.text as string, { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } });
