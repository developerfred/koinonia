// Display preferences: view (foco | painel), density, motion. Stored locally only.
type Prefs = { view: 'foco' | 'painel'; density: 'compact' | 'comfortable' | 'spacious'; motion: 'auto' | 'off' };
const KEY = 'koinonia-prefs';
const DEFAULTS: Prefs = { view: 'painel', density: 'comfortable', motion: 'auto' };

function load(): Prefs {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return { ...DEFAULTS }; }
}
function save(p: Prefs) { try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* storage unavailable */ } }

function apply(p: Prefs) {
  const d = document.documentElement;
  d.dataset.view = p.view; d.dataset.density = p.density; d.dataset.motion = p.motion;
  document.querySelectorAll<HTMLInputElement>('[data-pref]').forEach((el) => {
    const k = el.dataset.pref as keyof Prefs;
    if (el.type === 'radio') el.checked = p[k] === el.value;
    if (el.type === 'checkbox') el.checked = p[k] === el.dataset.on;
  });
  document.querySelectorAll<HTMLElement>('[data-view-toggle]').forEach((b) => {
    b.setAttribute('aria-pressed', String(p.view === 'foco'));
  });
}

function set(patch: Partial<Prefs>) {
  const p = { ...load(), ...patch };
  save(p); apply(p);
  const live = document.querySelector<HTMLElement>('[data-prefs-live]');
  if (live && patch.view) live.textContent = patch.view === 'foco' ? 'Foco view: one thing at a time' : 'Painel view: everything visible';
}

export function initPrefs() {
  apply(load());
  document.addEventListener('change', (e) => {
    const el = e.target as HTMLInputElement;
    const k = el?.dataset?.pref as keyof Prefs | undefined;
    if (!k) return;
    if (el.type === 'checkbox') set({ [k]: el.checked ? el.dataset.on : el.dataset.off } as Partial<Prefs>);
    else set({ [k]: el.value } as Partial<Prefs>);
  });
  document.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('[data-view-toggle]')) set({ view: load().view === 'foco' ? 'painel' : 'foco' });
  });
  document.addEventListener('keydown', (e) => {
    if (e.altKey && e.shiftKey && e.code === 'KeyV') { e.preventDefault(); set({ view: load().view === 'foco' ? 'painel' : 'foco' }); }
  });
}
initPrefs();
