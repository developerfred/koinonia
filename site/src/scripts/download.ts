// Download page: finds the newest `desktop-v*` release (pre-releases included, so /releases/latest does not apply),
// fills direct asset URLs from the release itself (never constructed), and highlights the build matching the visitor.
const REPO = 'developerfred/koinonia';
const API = `https://api.github.com/repos/${REPO}/releases?per_page=30`;
const RELEASES_URL = `https://github.com/${REPO}/releases`;
const CACHE_KEY = 'koinonia-desktop-release';
const CACHE_MS = 10 * 60 * 1000;

type Asset = { name: string; browser_download_url: string };
type Release = { tag_name: string; html_url: string; prerelease: boolean; draft?: boolean; published_at?: string; created_at?: string; assets: Asset[] };
type Slim = { tag: string; url: string; assets: Record<string, string> };
type Sys = { os: 'macos' | 'windows' | 'linux' | 'other'; arch: 'aarch64' | 'x86_64' | 'unknown'; label: string; mobile: boolean };

function slim(releases: Release[]): Slim | null {
  const list = releases
    .filter((r) => !r.draft && typeof r.tag_name === 'string' && r.tag_name.startsWith('desktop-v'))
    .sort((a, b) => Date.parse(b.published_at || b.created_at || '') - Date.parse(a.published_at || a.created_at || ''));
  const r = list[0];
  if (!r) return null;
  const assets: Record<string, string> = {};
  for (const a of r.assets || []) if (a && a.name && /^https:\/\//.test(a.browser_download_url)) assets[a.name] = a.browser_download_url;
  return { tag: r.tag_name, url: r.html_url, assets };
}

async function newest(): Promise<Slim | null> {
  try {
    const c = JSON.parse(sessionStorage.getItem(CACHE_KEY) || 'null');
    if (c && Date.now() - c.at < CACHE_MS && 'release' in c) return c.release;
  } catch { /* storage unavailable */ }
  const res = await fetch(API, { headers: { Accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error(`GitHub API ${res.status}`);
  const release = slim(await res.json());
  try { sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), release })); } catch { /* ignore */ }
  return release;
}

async function detect(): Promise<Sys> {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string; mobile?: boolean; getHighEntropyValues?: (h: string[]) => Promise<{ architecture?: string }> } };
  const ua = nav.userAgent || '';
  const uad = nav.userAgentData;
  const plat = (uad?.platform || '').toLowerCase();
  let os: Sys['os'] = 'other';
  if (plat === 'macos' || (!plat && /Macintosh|Mac OS X/.test(ua))) os = 'macos';
  else if (plat === 'windows' || (!plat && /Windows/.test(ua))) os = 'windows';
  else if (plat === 'linux' || (!plat && /Linux|X11/.test(ua))) os = 'linux';
  const mobile = !!uad?.mobile || /Android|iPhone|iPad|iPod|CrOS/.test(ua);
  if (mobile) os = 'other';

  let arch: Sys['arch'] = 'unknown';
  try {
    if (uad?.getHighEntropyValues) {
      const v = await uad.getHighEntropyValues(['architecture']);
      if (v.architecture === 'arm') arch = 'aarch64';
      else if (v.architecture === 'x86') arch = 'x86_64';
    }
  } catch { /* denied or unsupported */ }
  if (arch === 'unknown') {
    if (/aarch64|arm64|ARM64/.test(ua)) arch = 'aarch64';
    else if (/x86_64|x64|Win64|WOW64|amd64|AMD64/.test(ua)) arch = 'x86_64';
    else if (os === 'windows') arch = 'x86_64';
    // macOS browsers report "Intel" even on Apple silicon, so the UA alone cannot settle it.
  }
  const osName = { macos: 'macOS', windows: 'Windows', linux: 'Linux', other: 'an unsupported system' }[os];
  const archName = arch === 'aarch64' ? 'arm64' : arch === 'x86_64' ? 'x86_64' : '';
  return { os, arch, mobile, label: os === 'other' ? osName : `${osName}${archName ? ' ' + archName : ''}` };
}

const ext = (os: string) => (os === 'windows' ? 'zip' : 'tar.gz');
const archName = (a: string) => (a === 'aarch64' ? 'arm64' : a);

function init() {
  const root = document.querySelector<HTMLElement>('[data-dl]');
  if (!root) return;
  const status = root.querySelector<HTMLElement>('[data-dl-status]')!;
  const pick = root.querySelector<HTMLElement>('[data-dl-pick]')!;
  const pickLabel = root.querySelector<HTMLElement>('[data-dl-pick-label]')!;
  const pickActions = root.querySelector<HTMLElement>('[data-dl-pick-actions]')!;
  const rows = () => Array.from(document.querySelectorAll<HTMLTableRowElement>('[data-dl-table] tbody tr'));

  const link = (text: string, href: string, cls = '') => {
    const a = document.createElement('a'); a.href = href; a.textContent = text; if (cls) a.className = cls; a.rel = 'noopener'; return a;
  };

  Promise.all([detect(), newest().then((r) => ({ r, err: false }), () => ({ r: null as Slim | null, err: true }))]).then(([sys, { r, err }]) => {
    status.textContent = '';
    if (r) {
      status.append('Newest release: ', link(r.tag, r.url), ' (pre-release, alpha). Download links below come straight from that release.');
    } else {
      status.append(err
        ? 'Could not reach the GitHub API to look up releases. '
        : 'The first alpha is not published yet: there is no desktop release to download. ');
      status.append(link('Open the releases page', RELEASES_URL), err ? ' to check, or build from source (below).' : ' to watch for it, or build from source (below).');
      status.classList.add('dl-none');
    }

    for (const el of document.querySelectorAll<HTMLElement>('[data-asset]')) {
      const name = el.dataset.asset!;
      const file = `${name}.${el.dataset.ext}`;
      const url = r?.assets[file];
      if (r && url) {
        const a = link(el.dataset.ext === 'sha256' ? `${name}.sha256` : file, url, 'dl-file');
        el.textContent = ''; el.append(a);
      } else if (r) {
        el.append(' ', Object.assign(document.createElement('em'), { textContent: '(not in this release)' }));
      }
    }

    const want = (tr: HTMLTableRowElement) => {
      const asset = tr.querySelector<HTMLElement>('[data-asset]')?.dataset.asset || '';
      const m = /^koinonia-(\w+)-(\w+)$/.exec(asset);
      return m ? { os: m[1], arch: m[2] } : null;
    };
    let matched: HTMLTableRowElement[] = [];
    if (!sys.mobile && sys.os !== 'other') {
      matched = rows().filter((tr) => { const w = want(tr); return !!w && w.os === sys.os && (sys.arch === 'unknown' || w.arch === sys.arch); });
    }
    for (const tr of matched) {
      tr.classList.add('dl-match');
      const b = document.createElement('span'); b.className = 'dl-badge'; b.textContent = matched.length > 1 ? 'Possible match' : 'Your system';
      tr.cells[0].append(' ', b);
    }

    pick.hidden = false;
    pickActions.textContent = '';
    if (sys.mobile || sys.os === 'other') {
      pickLabel.textContent = 'Your device looks like a phone, tablet or an unsupported system. The desktop app needs macOS, Windows or Linux on a computer. Pick a build from the table below if you are downloading for another machine.';
    } else if (matched.length === 1) {
      const w = want(matched[0])!; const file = `koinonia-${w.os}-${w.arch}.${ext(w.os)}`;
      const tested = w.os === 'macos' && w.arch === 'aarch64';
      pickLabel.textContent = `Detected: ${sys.label}. ${tested ? 'This is the one build the maintainers have run.' : 'The maintainers have not run this build; expect rough edges.'}`;
      const url = r?.assets[file];
      if (url) pickActions.append(link(`Download ${file}`, url, 'dl-btn'));
    } else if (matched.length > 1) {
      pickLabel.textContent = `Detected: ${sys.label}, but your browser does not reveal the CPU. Apple silicon Macs (M1 or newer) need the arm64 build; older Intel Macs use x86_64. Check Apple menu, About This Mac.`;
      for (const tr of matched) {
        const w = want(tr)!; const file = `koinonia-${w.os}-${w.arch}.${ext(w.os)}`; const url = r?.assets[file];
        if (url) pickActions.append(link(`Download ${archName(w.arch)}`, url, 'dl-btn'));
      }
    } else {
      pickLabel.textContent = 'Your system could not be detected. Pick a build from the table below.';
    }
    if (!r) pickLabel.textContent += ' No download is available yet.';
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
