import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// Applies saved display preferences before first paint (no flash). Keys mirror src/scripts/prefs.ts.
const PREFS_BOOT = `try{var d=document.documentElement,p=JSON.parse(localStorage.getItem('koinonia-prefs')||'{}');if(p.view)d.dataset.view=p.view;if(p.density)d.dataset.density=p.density;if(p.motion)d.dataset.motion=p.motion}catch(e){}`;

// Deployed to https://developerfred.github.io/koinonia/ (GitHub Pages project site).
export default defineConfig({
  site: 'https://developerfred.github.io',
  base: '/koinonia',
  trailingSlash: 'always',
  build: { format: 'directory' },
  integrations: [
    starlight({
      title: 'Koinonia',
      description:
        'Open-source live-streaming studio that runs in the browser, with a Zig daemon and WebMCP tools so agents can run the show. Twitch and YouTube, no OBS.',
      logo: { src: './src/assets/mark.svg', alt: '' },
      favicon: '/favicon.svg',
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/developerfred/koinonia' }],
      editLink: { baseUrl: 'https://github.com/developerfred/koinonia/edit/main/site/' },
      lastUpdated: false,
      customCss: ['./src/styles/tokens.css', './src/styles/prefs.css', './src/styles/docs.css'],
      components: {
        PageTitle: './src/components/PageTitle.astro',
        ThemeSelect: './src/components/ThemeSelect.astro',
        Head: './src/components/Head.astro',
      },
      head: [
        { tag: 'script', content: PREFS_BOOT },
        { tag: 'meta', attrs: { property: 'og:image', content: 'https://developerfred.github.io/koinonia/og.png' } },
        { tag: 'meta', attrs: { property: 'og:image:width', content: '1200' } },
        { tag: 'meta', attrs: { property: 'og:image:height', content: '630' } },
        { tag: 'meta', attrs: { name: 'twitter:card', content: 'summary_large_image' } },
        { tag: 'meta', attrs: { name: 'twitter:image', content: 'https://developerfred.github.io/koinonia/og.png' } },
        { tag: 'link', attrs: { rel: 'alternate', type: 'text/plain', href: '/koinonia/llms.txt', title: 'llms.txt' } },
      ],
      sidebar: [
        { label: 'Start here', items: ['docs', 'docs/status', 'docs/quickstart'] },
        {
          label: 'Concepts',
          items: ['docs/concepts/architecture', 'docs/concepts/webmcp', 'docs/concepts/cursors-and-deltas', 'docs/concepts/views'],
        },
        {
          label: 'Reference',
          items: [
            { label: 'WebMCP tools', items: [{ autogenerate: { directory: 'docs/reference/tools' } }] },
            'docs/reference/daemon-protocol',
            'docs/reference/tokens-package',
            'docs/reference/docs-site-tools',
          ],
        },
        { label: 'Guides', items: ['docs/guides/token-economy', 'docs/guides/ux-accessibility', 'docs/guides/agents'] },
        { label: 'Project', items: ['docs/security', 'docs/roadmap', 'docs/contributing'] },
      ],
    }),
  ],
});
