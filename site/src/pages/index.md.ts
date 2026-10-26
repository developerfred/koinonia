import type { APIRoute } from 'astro';
import { landingTwin } from '../lib/site';

export const GET: APIRoute = () =>
  new Response(landingTwin(), { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } });
