// WebMCP tool contract for the Koinonia studio. Schemas mirror studio/src/tools/tools.ts (read at authoring time).
// status: built = registered in the studio tool layer with tests; wip = registered but depends on platform/daemon
// integration that is not finished; planned = not in the code yet.
// Human confirmation for sensitive tools is a design commitment: it is NOT implemented in studio/ yet.

export const GROUPS = {
  copilot: { title: 'Production co-pilot', blurb: 'Read chat, run the show, go live.' },
  clipper: { title: 'Clipper', blurb: 'Mark and export highlights from a circular buffer.' },
  data: { title: 'Data panel', blurb: 'Stream state, windowed metrics, threshold alerts.' },
  tokens: { title: 'Token economy', blurb: 'Observe and bound what the agent spends.' },
};

const targets = { type: 'array', items: { enum: ['twitch', 'youtube'] } };
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

export const TOOLS = [
  {
    name: 'get_chat', group: 'copilot', status: 'built', sensitive: false,
    summary: 'Cursor-based chat delta, deduplicated and compact.',
    description: 'Chat delta since a cursor. Returns the next cursor c and compact items. Identical texts are folded into one item with a repeat count x. Always pass c back as the next since_cursor; never request the full history.',
    notes: 'Implemented on the chat ring (studio/src/chat/ring.ts). Keys are shortened on purpose: i=id, ts=timestamp, p=platform, u=user, t=text, x=repeat count.',
    input: obj({
      since_cursor: { type: 'integer', minimum: 0, description: '0 = from oldest buffered' },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
      fields: { type: 'array', items: { enum: ['id', 'ts', 'platform', 'user', 'text'] }, description: 'default [user,text]' },
      dedupe: { type: 'boolean' },
    }),
    call: { since_cursor: 1184, limit: 30 },
    result: { c: 1213, m: [{ u: 'mika', t: 'POG', x: 14 }, { u: 'dani', t: 'qual a trilha?' }, { u: 'rex', t: 'first time here, love the overlay' }] },
    resultNote: 'c is the next cursor. more:true means the limit cut the page short. lost:N means N messages fell off the ring before you read them. Defaults: limit 30, fields user and text, dedupe on.',
  },
  {
    name: 'create_poll', group: 'copilot', status: 'wip', sensitive: false,
    summary: 'Create a poll with 2 to 5 options.',
    description: 'Creates a poll. Registered in the tool layer; posting it to Twitch and YouTube depends on the platform connectors (phase 2).',
    input: obj({ question: { type: 'string' }, options: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 5 }, duration_sec: { type: 'integer', minimum: 15, maximum: 1800 } }, ['question', 'options']),
    call: { question: 'Next game?', options: ['Hades II', 'Celeste', 'Tunic'], duration_sec: 90 },
    result: { id: 'poll_1', question: 'Next game?', options: ['Hades II', 'Celeste', 'Tunic'] },
    resultNote: 'The result shape is illustrative; the studio API returns whatever createPoll yields. Default duration is 60 seconds.',
  },
  {
    name: 'pin_message', group: 'copilot', status: 'wip', sensitive: false,
    summary: 'Pin a chat message by cursor id.',
    description: 'Pins a chat message identified by its id (the cursor id from get_chat). Returns an error for an unknown id.',
    input: obj({ id: { type: 'integer' } }, ['id']),
    call: { id: 1190 },
    result: { ok: 1 },
  },
  {
    name: 'switch_scene', group: 'copilot', status: 'built', sensitive: false,
    summary: 'Switch the active scene.',
    description: 'Changes the active scene rendered by the compositor Worker. An unknown name returns an error that lists the scene names.',
    input: obj({ scene: { type: 'string' } }, ['scene']),
    call: { scene: 'gameplay' },
    result: { scene: 'gameplay' },
  },
  {
    name: 'set_layer', group: 'copilot', status: 'built', sensitive: false,
    summary: 'Show, hide, move or fade a layer.',
    description: 'Patches a layer in the current (or given) scene. Geometry is 0 to 1 fractions of the canvas, so it is resolution independent.',
    input: obj({ id: { type: 'string' }, scene: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' }, opacity: { type: 'number' }, visible: { type: 'boolean' } }, ['id']),
    call: { id: 'webcam', x: 0.72, y: 0.7, w: 0.25, h: 0.25 },
    result: { id: 'webcam', x: 0.72, y: 0.7, w: 0.25, h: 0.25, o: 1, v: true },
    resultNote: 'Short keys: o = opacity, v = visible.',
  },
  {
    name: 'set_audio', group: 'copilot', status: 'built', sensitive: false,
    summary: 'Mute and volume for an audio source.',
    description: 'Sets mute and/or volume (0 to 1) for a source. Sources are mic or screen.',
    input: obj({ source: { type: 'string' }, muted: { type: 'boolean' }, volume: { type: 'number', minimum: 0, maximum: 1 } }, ['source']),
    call: { source: 'mic', volume: 0.8 },
    result: { ok: 1 },
  },
  {
    name: 'set_overlay_text', group: 'copilot', status: 'built', sensitive: false,
    summary: 'Set the lower-third overlay text.',
    description: 'Sets the lower-third overlay text (plain text, up to 200 characters). An empty string hides it.',
    input: obj({ text: { type: 'string', maxLength: 200 } }, ['text']),
    call: { text: 'Chat picked: Hades II' },
    result: { ok: 1 },
  },
  {
    name: 'start_stream', group: 'copilot', status: 'wip', sensitive: true,
    summary: 'Start encoding and send to the daemon.',
    description: 'Starts encoding and streaming through the daemon to the chosen targets (all configured destinations when omitted). Going live is treated as sensitive: the design is that the studio asks the human to confirm first. That confirmation gate is not implemented yet.',
    input: obj({ targets }),
    call: { targets: ['twitch', 'youtube'] },
    result: { state: 'live' },
    resultNote: 'The result shape is illustrative. Under the planned confirmation gate the first response would be a pending state until a human accepts.',
  },
  {
    name: 'stop_stream', group: 'copilot', status: 'wip', sensitive: true,
    summary: 'Stop streaming.',
    description: 'Stops encoding and closes the outputs. Planned to be confirmation-gated by default.',
    input: obj({}),
    call: {},
    result: { state: 'stopped' },
  },
  {
    name: 'capture_frame', group: 'copilot', status: 'wip', sensitive: false,
    summary: 'Small JPEG snapshot of the program output.',
    description: 'Returns a small JPEG (base64) of the program output. Costly in tokens; use sparingly. Returns an error when not live or when no canvas is available.',
    input: obj({ width: { type: 'integer', minimum: 64, maximum: 1280 }, quality: { type: 'number', minimum: 0.1, maximum: 1 } }),
    call: { width: 320, quality: 0.6 },
    result: { mime: 'image/jpeg', b64: '<base64>' },
    resultNote: 'Defaults: width 320, quality 0.6.',
  },
  {
    name: 'ban_user', group: 'copilot', status: 'planned', sensitive: true,
    summary: 'Ban or time out a chatter. Always human-confirmed.',
    description: 'Proposed moderation tool, not in the code yet. It must never execute without an explicit human confirmation in the studio UI, and that rule is not configurable.',
    input: obj({ platform: { enum: ['twitch', 'youtube'] }, user: { type: 'string' }, duration_s: { type: 'integer', minimum: 1, description: 'Omit for a permanent ban.' }, reason: { type: 'string', maxLength: 200 } }, ['platform', 'user']),
    call: { platform: 'twitch', user: 'spam_bot_42', reason: 'link spam' },
    result: { state: 'awaiting_confirmation', confirm_id: 'cf_9' },
    resultNote: 'Proposed shape.',
  },
  {
    name: 'mark_highlight', group: 'clipper', status: 'built', sensitive: false,
    summary: 'Mark the current moment for the clipper.',
    description: 'Drops a marker at the current moment so it can be exported later. Cheap; call it freely.',
    input: obj({ label: { type: 'string', maxLength: 80 } }),
    call: { label: 'boss kill' },
    result: { id: 1, t: 2467000 },
    resultNote: 'The result shape is illustrative.',
  },
  {
    name: 'export_clip', group: 'clipper', status: 'wip', sensitive: false,
    summary: 'Cut a clip from the circular buffer.',
    description: 'Asks the daemon to export the last N seconds from its MPEG-TS ring buffer. The daemon replies with a clip status frame containing the path. The ring size is KOINONIA_CLIP_SECONDS (default 300).',
    input: obj({ seconds_back: { type: 'integer', minimum: 5, maximum: 600 }, title: { type: 'string', maxLength: 100 } }, ['seconds_back']),
    call: { seconds_back: 30, title: 'Boss kill' },
    result: { type: 'clip', ok: true, path: 'clips/2026-10-26T20-40-00_boss_kill.ts', seconds: 30 },
    resultNote: 'Matches the daemon status frame for clips; the studio may wrap it.',
  },
  {
    name: 'query_window', group: 'data', status: 'built', sensitive: false,
    summary: 'Aggregate a metric over the last N seconds.',
    description: 'Aggregates a metric (kbps, dropped, fps, chat_rate and so on) over the last N seconds and returns the stream state. Alerts that fired since the last call are included in alerts, so one tool serves both polling and alerting. Without a metric it lists metric names.',
    notes: 'Implemented on the metrics store (studio/src/metrics.ts).',
    input: obj({ metric: { type: 'string' }, last_sec: { type: 'integer', minimum: 1, maximum: 3600 }, agg: { enum: ['avg', 'min', 'max', 'last', 'count', 'rate'] } }),
    call: { metric: 'kbps', last_sec: 60, agg: 'avg' },
    result: { n: 58, v: 5914.2, state: 'live' },
    resultNote: 'Defaults: last_sec 60, agg avg. The state value is illustrative.',
  },
  {
    name: 'set_alert', group: 'data', status: 'built', sensitive: false,
    summary: 'Alert when a metric crosses a threshold.',
    description: 'Registers an edge-triggered alert: it fires once when the threshold is crossed and re-arms when the value returns to range. Fired alerts are reported through query_window. Pass remove_id to delete one.',
    input: obj({ metric: { type: 'string' }, op: { enum: ['gt', 'lt'] }, threshold: { type: 'number' }, remove_id: { type: 'integer' } }),
    call: { metric: 'kbps', op: 'lt', threshold: 3000 },
    result: { id: 3 },
  },
  {
    name: 'get_token_report', group: 'tokens', status: 'planned', sensitive: false,
    summary: 'Tokens spent and saved, per tool and task.',
    description: 'Proposed, not in the code yet. The spend ledger exists in @koinonia/tokens; this tool would expose it to the agent: tokens per tool, estimated savings, budget remaining.',
    input: obj({ window_s: { type: 'integer', minimum: 60 } }),
    call: { window_s: 3600 },
    result: { spent: 41200, saved_est: 118000, budget_left: 58800 },
    resultNote: 'Proposed shape with made-up numbers.',
  },
];

export const toolsByGroup = () =>
  Object.entries(GROUPS).map(([id, g]) => ({ id, ...g, tools: TOOLS.filter((t) => t.group === id) }));
