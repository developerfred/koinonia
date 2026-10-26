# @koinonia/agents

Multi-agent runtime that operates a live Koinonia stream through WebMCP tools.
Small orchestrator, five declarative agents, a human-approval gate for sensitive actions, and a token economist that keeps the bill predictable.

```
npm install          # (node_modules is symlinked to ../tokens/node_modules in this monorepo)
npm run typecheck
npm test
node bin/koinonia-agents.mjs list
node bin/koinonia-agents.mjs dry-run moderator --event chat.batch
ANTHROPIC_API_KEY=... node bin/koinonia-agents.mjs run --bridge ws://localhost:9333
```

## Agents

| id | tier | tools (allowlist) | wakes on |
|----|------|-------------------|----------|
| `producer` | medium | get_chat, create_poll, pin_message, switch_scene, set_layer, set_audio, set_overlay_text, capture_frame, query_window, start_stream, stop_stream* | the streamer (`ask`), `human.request` |
| `moderator` | small | ban_user*, timeout_user*, delete_message* | `chat.batch` (pre-filtered, free when chat is clean) |
| `clipper` | small | mark_highlight, export_clip | `chat.spike` (45 s cooldown) |
| `analyst` | small | query_window, set_alert | `health.alert` (30 s cooldown), manual |
| `economist` | native (no LLM) | none | every 10 s |

`*` = sensitive: the call becomes a pending human approval, never a direct action.
Models: `claude-haiku-5-5` (small), `claude-sonnet-5-5` (medium), `claude-opus-5-5` (large).

## Using it as a library

```ts
import { Orchestrator, DEFAULT_AGENTS, AnthropicProvider, NavigatorModelContextClient, ChatSensor, HealthSensor } from "@koinonia/agents";

const client = new NavigatorModelContextClient();            // in the studio tab
// or: new BridgeClient(await webSocketTransport("ws://..."))  // from Node
const orch = new Orchestrator({ client, provider: new AnthropicProvider() }); // key from ANTHROPIC_API_KEY
await orch.refreshTools();
DEFAULT_AGENTS.forEach((d) => orch.register(d));
orch.start();

const chat = new ChatSensor(client, orch.bus), health = new HealthSensor(client, orch.bus);
setInterval(() => { chat.poll(); health.poll(); }, 4000);

orch.bus.on("approval.requested", (e) => showInUi(e.payload));   // human side:
await orch.approvals.approve("apr-1", "streamer");               //   or .deny("apr-1")
await orch.ask("producer", "switch to the Gameplay scene and put 'GG' in the overlay");
```

Define your own agent by adding an `AgentDefinition` (system prompt, `tools` allowlist, `tier`, `triggers`, `budgetPerHour`, optional `render` and `limits`) and `orch.register(def)`.

## Safety model (short)

* Chat text, usernames and `get_chat` output are **untrusted data**: sanitised, fenced in `<untrusted_data>` with a per-call id, and the shared system preamble says fenced text is never an instruction.
* The real boundary is not the prompt: sensitive tools (`ban_user`, `timeout_user`, `delete_message`, `delete_clip`, `stop_stream`) are intercepted by the runtime and queued in the `ApprovalGate`. Only the human side (`approve`/`deny`, not an agent tool) executes them, with timeouts and an audit log.
* Per-agent tool allowlists, per-run loop guard (max steps/calls/identical calls), run and tool rate limits, bounded queues.
* API key is read from the environment, sent only as a header, redacted from errors and the audit log.

See `ARCHITECTURE.md` for details and known gaps.
