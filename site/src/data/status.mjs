// Single source of truth for "what exists" on the site.
// Verified against the repo working tree (daemon/, studio/, tokens/) at authoring time.
// built = code exists in the repo; wip = scaffolding / partial; planned = not started.
export const STATUS = {
  built: { label: 'Built', blurb: 'Code exists in the repository.' },
  wip: { label: 'In progress', blurb: 'Scaffolded or partially implemented.' },
  planned: { label: 'Planned', blurb: 'Designed, not yet implemented.' },
};

export const COMPONENTS = [
  { id: 'tokens', name: '@koinonia/tokens', status: 'built', where: 'tokens/', note: 'Consume side (delta cursors, chat compaction, output trimming, rolling summary) and spend side (model router, prompt-cache planner, budget tracker, response cache, event batcher, usage ledger). Unit tests included.' },
  { id: 'chatring', name: 'Chat ring buffer', status: 'built', where: 'studio/src/chat/ring.ts', note: 'Cursor-addressed ring with dedupe, compact keys, lost-count.' },
  { id: 'metrics', name: 'Metrics store and alerts', status: 'built', where: 'studio/src/metrics.ts', note: 'Time-series ring, windowed aggregates, edge-triggered threshold alerts.' },
  { id: 'tools', name: 'WebMCP tool layer in the studio', status: 'wip', where: 'studio/src/tools/', note: '14 tools registered through navigator.modelContext, with a polyfill fallback and tests. Platform actions (polls, pins), going live and clips depend on connectors and the daemon; no human-confirmation gate yet.' },
  { id: 'studio', name: 'Browser studio (capture, Worker compositor, WebCodecs, UI)', status: 'wip', where: 'studio/', note: 'Compositor Worker, scene model, transport, and a Foco/Painel UI with preferences and tests exist. Not yet verified end to end against the daemon or a live platform.' },
  { id: 'daemon', name: 'Zig daemon koinonia-d', status: 'wip', where: 'daemon/', note: 'WebSocket ingest, frame parser, FLV and RTMPS publisher, MPEG-TS ring, fan-out and config code exist, with a written v1 protocol. Not yet verified against Twitch or YouTube.' },
  { id: 'platforms', name: 'Twitch and YouTube chat connectors', status: 'planned', where: '-', note: 'Phase 2 and 9.' },
  { id: 'dashboard', name: 'Data panel UI (SSE/WebSocket)', status: 'planned', where: '-', note: 'Phase 5. The metrics store and query_window tool exist.' },
  { id: 'confirm', name: 'Human confirmation gate for sensitive tools', status: 'planned', where: '-', note: 'Design commitment; ban_user itself is not written yet.' },
];

export const PHASES = [
  { n: 0, title: 'Risk spikes', status: 'wip', body: 'Background-tab frame rate and AAC through WebCodecs.' },
  { n: 1, title: 'End-to-end spike', status: 'wip', body: 'Camera, WebCodecs, Zig daemon, Twitch. Both ends of the pipeline have code; live verification is pending.' },
  { n: 2, title: 'YouTube in parallel', status: 'wip', body: 'Daemon fan-out to several RTMPS destinations exists; chat from both platforms and live verification are pending.' },
  { n: 3, title: 'Co-pilot WebMCP tools', status: 'wip', body: '14 tools registered with tests; platform integration and confirmation gate pending.' },
  { n: 4, title: 'Clipper', status: 'wip', body: 'Daemon MPEG-TS ring and tools exist; end-to-end export is unverified.' },
  { n: 5, title: 'Data panel', status: 'wip', body: 'Metrics store and tools exist; the panel UI is pending.' },
  { n: 6, title: 'Token-economy agent', status: 'wip', body: 'Toolkit built, consume and spend sides. Wiring into the live agent loop is pending.' },
  { n: 7, title: 'Docs, CI, release', status: 'wip', body: 'This site is the first piece. CI for the code and a tagged release are pending.' },
  { n: 8, title: 'Design system and the two views', status: 'wip', body: 'Foco and Painel exist in the studio UI; the design system is still taking shape.' },
  { n: 9, title: 'Unified chat connectors', status: 'planned', body: 'Twitch and YouTube chat in one stream, with human-approved moderation.' },
  { n: 10, title: 'Vertical clip pipeline', status: 'planned', body: '9:16 clips with captions and publishing to Shorts, TikTok and Reels.' },
  { n: 11, title: 'Automatic post-live', status: 'planned', body: 'Summary, chapters, suggested title and thumbnail, report.' },
  { n: 12, title: 'Onboarding and interaction ideas', status: 'planned', body: 'Setup in minutes in the browser; the agent suggests polls and challenges from chat.' },
];
