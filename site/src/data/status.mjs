// Single source of truth for "what exists" on the site.
// Verified against the repo working tree (daemon/, studio/, tokens/, agents/, desktop/, qa/) at authoring time.
// Nothing has been verified against real Twitch or YouTube yet, apart from the maintainer's first test live.
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
  { id: 'tools', name: 'WebMCP tool layer in the studio', status: 'wip', where: 'studio/src/tools/', note: '14 tools registered through navigator.modelContext, with a polyfill fallback and tests. Moderation tools go through a human approval queue. Not yet exercised against real platforms.' },
  { id: 'studio', name: 'Browser studio (capture, Worker compositor, WebCodecs, UI)', status: 'wip', where: 'studio/', note: 'Compositor Worker, scene model, transport, and a Foco/Painel UI with preferences and tests exist. Only a first test live has been run; not yet verified against real Twitch or YouTube.' },
  { id: 'daemon', name: 'Zig daemon koinonia-d', status: 'wip', where: 'daemon/', note: 'WebSocket ingest, frame parser, FLV and RTMPS publisher, MPEG-TS clip ring, fan-out and config, with a written v1 protocol. Not yet verified against real Twitch or YouTube beyond the first test live.' },
  { id: 'desktop', name: 'Desktop app', status: 'built', where: 'desktop/', note: 'One native Zig binary that runs the daemon, serves the studio and opens it as an app window in an installed Chromium-family browser. Built and tested on macOS arm64 only. No release downloads yet.' },
  { id: 'agents', name: 'Agents runtime', status: 'built', where: 'agents/', note: 'Orchestrator, five declarative agents (producer, moderator, clipper, analyst, economist), human-approval gate and token economist. Tests included; not yet run against a real stream.' },
  { id: 'platforms', name: 'Twitch and YouTube chat connectors', status: 'built', where: 'studio/src/', note: 'Code exists. Not yet verified against live Twitch or YouTube chat beyond the first test live.' },
  { id: 'clips', name: 'Clips (daemon ring, mark and export tools)', status: 'wip', where: 'daemon/, studio/src/tools/', note: 'Code exists. Vertical captioned clips and publishing are still planned.' },
  { id: 'qa', name: 'QA harness', status: 'built', where: 'qa/', note: 'One command runs unit, contract, integration against fake RTMP sinks, end-to-end, fuzz and property, security, token-economy and site gates.' },
  { id: 'dashboard', name: 'Data panel UI (SSE/WebSocket)', status: 'planned', where: '-', note: 'Phase 5. The metrics store and query_window tool exist.' },
];

export const PHASES = [
  { n: 0, title: 'Risk spikes', status: 'wip', body: 'Background-tab frame rate and AAC through WebCodecs.' },
  { n: 1, title: 'End-to-end spike', status: 'wip', body: 'Camera, WebCodecs, Zig daemon, Twitch. Both ends of the pipeline have code; live verification is pending.' },
  { n: 2, title: 'YouTube in parallel', status: 'wip', body: 'Daemon fan-out to several RTMPS destinations and chat connectors exist; verification against real YouTube is pending.' },
  { n: 3, title: 'Co-pilot WebMCP tools', status: 'wip', body: '14 tools registered with tests and a human approval queue for moderation; verification on real platforms is pending.' },
  { n: 4, title: 'Clipper', status: 'wip', body: 'Daemon MPEG-TS ring and mark/export tools exist; verification on a real stream is pending.' },
  { n: 5, title: 'Data panel', status: 'wip', body: 'Metrics store and tools exist; the panel UI is pending.' },
  { n: 6, title: 'Token-economy agent', status: 'built', body: 'Toolkit and agents runtime built, consume and spend sides. Not yet run against a real stream.' },
  { n: 7, title: 'Docs, CI, release', status: 'wip', body: 'This site, the QA harness and the desktop app exist. A tagged release and download links are pending.' },
  { n: 8, title: 'Design system and the two views', status: 'wip', body: 'Foco and Painel exist in the studio UI; the design system is still taking shape.' },
  { n: 9, title: 'Unified chat connectors', status: 'built', body: 'Twitch and YouTube chat in one stream, with human-approved moderation. Code exists; live verification is pending.' },
  { n: 10, title: 'Vertical clip pipeline', status: 'planned', body: '9:16 clips with captions and publishing to Shorts, TikTok and Reels.' },
  { n: 11, title: 'Automatic post-live', status: 'planned', body: 'Summary, chapters, suggested title and thumbnail, report.' },
  { n: 12, title: 'Onboarding and interaction ideas', status: 'planned', body: 'Setup in minutes in the browser; the agent suggests polls and challenges from chat.' },
];
