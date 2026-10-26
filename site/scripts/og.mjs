// Generates public/og.png (1200x630) with satori (text -> paths) + sharp. Run manually: node scripts/og.mjs
import satori from 'satori';
import sharp from 'sharp';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const font = (p, name, weight, style = 'normal') => ({ name, weight, style, data: readFileSync(require.resolve(p)) });
const fonts = [
  font('@fontsource/fraunces/files/fraunces-latin-500-normal.woff', 'Fraunces', 500),
  font('@fontsource/fraunces/files/fraunces-latin-400-italic.woff', 'Fraunces', 400, 'italic'),
  font('@fontsource/noto-serif-display/files/noto-serif-display-greek-300-italic.woff', 'Greek', 300, 'italic'),
  font('@fontsource/martian-mono/files/martian-mono-latin-400-normal.woff', 'Mono', 400),
];
const bone = '#f1ebdc', tally = '#ff5636', muted = '#aaa493';
const h = (type, style, children) => ({ type, props: { style, children } });
const tree = h('div', { display: 'flex', flexDirection: 'column', width: 1200, height: 630, background: '#0e0d0b', padding: '70px 80px', position: 'relative' }, [
  h('div', { position: 'absolute', left: 600, top: 400, fontFamily: 'Greek', fontStyle: 'italic', fontWeight: 300, fontSize: 220, color: 'rgba(236,230,216,0.10)' }, 'κοινωνία'),
  h('div', { display: 'flex', alignItems: 'center', gap: 14, fontFamily: 'Mono', fontSize: 18, color: muted }, [
    h('div', { width: 18, height: 18, borderRadius: 9, background: tally }, ''),
    h('div', {}, 'PRE-ALPHA · OPEN SOURCE · MIT'),
  ]),
  h('div', { display: 'flex', flexDirection: 'column', fontFamily: 'Fraunces', fontWeight: 500, fontSize: 90, lineHeight: 1.06, color: bone, marginTop: 40, letterSpacing: -4 }, [
    h('div', {}, 'The studio is'),
    h('div', { display: 'flex' }, [h('div', { marginRight: 26 }, 'a'), h('div', { fontStyle: 'italic', fontWeight: 400, color: tally }, 'browser tab.')]),
    h('div', {}, 'The operator is an agent.'),
  ]),
  h('div', { position: 'absolute', left: 80, top: 552, fontFamily: 'Mono', fontSize: 20, color: muted }, 'KOINONIA · WebMCP · Zig · Twitch + YouTube, no OBS'),
]);
const svg = await satori(tree, { width: 1200, height: 630, fonts });
await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile(new URL('../public/og.png', import.meta.url).pathname);
console.log('og.png written');
