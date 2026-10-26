import { readFileSync } from "node:fs";
import { SAFETY_PREAMBLE } from "./agent.ts";
import { DEFAULT_AGENTS } from "./definitions.ts";
import { Orchestrator } from "./orchestrator.ts";
import { AnthropicProvider } from "./providers/anthropic.ts";
import { EchoProvider } from "./providers/fake.ts";
import { ChatSensor, HealthSensor } from "./sensors.ts";
import { estimateTokens } from "../../tokens/src/index.ts";
import { BridgeServer } from "./bridge-server.ts";
import { linkBridge } from "./bridge-link.ts";
import { BridgeClient, studioLikeMock, webSocketTransport } from "./webmcp.ts";

const HELP = `koinonia-agents <command>

  list                          Show agents, tiers, tool allowlists, triggers, budgets
  dry-run <agent> [opts]        Build the exact prompt/tools for an event; NO model call, NO tool calls
      --event <topic>             default: human.request (or the agent's first event trigger)
      --payload <json|@file>      event payload (default: {"text":"hello"} / sample chat)
      --text <string>             shortcut for human.request
  run [opts]                    Operate a live studio (needs ANTHROPIC_API_KEY)
      --bridge <ws-url>           WebSocket bridge to the studio page (required)
      --agents a,b,c             subset (default: all)
      --poll-ms <n>              sensor poll period (default 4000)
  bridge [opts]                 Start the relay between agents and the studio page (open the studio with ?bridge=ws://127.0.0.1:<port>)
      --port <n>                  default 9333 (env KOINONIA_BRIDGE_PORT)
      --token <secret>            optional shared secret (env KOINONIA_BRIDGE_TOKEN); clients add ?token=
  help
In 'run', type "approve <id>", "deny <id>", "pending", "status" or "quit" on stdin.`;

type Out = (s: string) => void;
const proc = (globalThis as unknown as { process: { stdout: { write(s: string): void }; stdin: { on(ev: string, f: (d: unknown) => void): void }; env: Record<string, string | undefined> } }).process;

function parseFlags(args: string[]): { pos: string[]; f: Record<string, string> } {
  const pos: string[] = [], f: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) f[a.slice(2)] = args[i + 1] && !args[i + 1]!.startsWith("--") ? args[++i]! : "true";
    else pos.push(a);
  }
  return { pos, f };
}

export async function main(argv: string[], out: Out = (s) => proc.stdout.write(s + "\n")): Promise<number> {
  const [cmd, ...rest] = argv;
  const { pos, f } = parseFlags(rest);
  switch (cmd) {
    case "list": return list(out);
    case "dry-run": return dryRun(pos[0], f, out);
    case "run": return run(f, out);
    case "bridge": return bridge(f, out);
    case undefined: case "help": case "--help": out(HELP); return 0;
    default: out(`unknown command '${cmd}'\n\n${HELP}`); return 2;
  }
}

function list(out: Out): number {
  for (const d of DEFAULT_AGENTS) {
    const trig = d.triggers.map((t) => (t.kind === "event" ? `event:${t.topic}` : t.kind === "interval" ? `every ${t.everyMs}ms` : "manual")).join(", ");
    out(`${d.id}  [${d.native ? "native" : d.tier}]  ${d.title}`);
    out(`  tools:    ${d.tools.join(", ") || "(none)"}`);
    out(`  triggers: ${trig}`);
    out(`  budget:   ${d.budgetPerHour} tokens/h, priority ${d.priority}`);
  }
  return 0;
}

async function dryRun(agent: string | undefined, f: Record<string, string>, out: Out): Promise<number> {
  const def = DEFAULT_AGENTS.find((d) => d.id === agent);
  if (!def) { out(`dry-run needs a known agent: ${DEFAULT_AGENTS.map((d) => d.id).join(", ")}`); return 2; }
  if (def.native) { out(`${def.id} is native (no LLM); nothing to dry-run.`); return 0; }
  const echo = new EchoProvider();
  const orch = new Orchestrator({ client: studioLikeMock(), provider: echo, timers: false });
  await orch.refreshTools();
  orch.register(def);
  orch.start(def.id);
  const firstEvent = def.triggers.find((t) => t.kind === "event");
  const topic = f.event ?? (f.text ? "human.request" : firstEvent?.kind === "event" ? firstEvent.topic : "human.request");
  let payload: unknown = f.text ? { text: f.text } : topic === "human.request" ? { text: "hello" } : sample(topic);
  if (f.payload) payload = JSON.parse(f.payload.startsWith("@") ? readFileSync(f.payload.slice(1), "utf8") : f.payload);
  await orch.trigger(def.id, topic, payload);
  const req = echo.requests[0];
  if (!req) { out("No model request was made (skipped by a guard)."); out(JSON.stringify(orch.audit.all().slice(-3))); return 1; }
  out(`# dry-run ${def.id} on '${topic}'  (no model call, no tool call, no network)`);
  out(`model: ${req.model}  max_tokens: ${req.maxTokens}  cache: ${req.cache}`);
  out(`tools sent: ${req.tools.map((t) => t.name).join(", ") || "(none)"}`);
  out(`est. input tokens: ~${estimateTokens([req.system, req.tools, req.messages])} (cacheable prefix ~${estimateTokens([req.system, req.tools])})`);
  out(`--- system (${SAFETY_PREAMBLE.split("\n")[0]!.slice(0, 40)}...) ---\n${req.system}`);
  out(`--- user ---\n${typeof req.messages[0]!.content === "string" ? req.messages[0]!.content : JSON.stringify(req.messages[0]!.content)}`);
  return 0;
}

function sample(topic: string): unknown {
  if (topic === "chat.spike") return { rate: 9, baseline: 1.2, windowSec: 4, sample: [{ user: "a", text: "OMG CLUTCH", count: 6 }, { user: "b", text: "POGGERS", count: 3 }] };
  if (topic === "chat.batch") return { messages: [{ id: 1, user: "viewer1", text: "great stream" }, { id: 2, user: "spammer", text: "buy followers http://x.ru", count: 4 }] };
  if (topic === "health.alert") return { alerts: [{ metric: "dropped", op: "gt", threshold: 30, value: 55 }] };
  return {};
}

async function bridge(f: Record<string, string>, out: Out): Promise<number> {
  const port = Number(f.port ?? proc.env.KOINONIA_BRIDGE_PORT ?? 9333);
  const srv = await new BridgeServer({ port, token: f.token ?? proc.env.KOINONIA_BRIDGE_TOKEN, log: (s) => out(s) }).listen();
  out(`bridge listening on ws://127.0.0.1:${srv.port}  (studio: ?bridge=ws://127.0.0.1:${srv.port}; agents: run --bridge ws://127.0.0.1:${srv.port})`);
  return new Promise<number>(() => {}); // runs until killed
}

async function run(f: Record<string, string>, out: Out): Promise<number> {
  if (!f.bridge) { out("run needs --bridge <ws-url> (the studio page's WebMCP bridge)"); return 2; }
  let provider;
  try { provider = new AnthropicProvider(); } catch (e) { out(String((e as Error).message)); return 2; }
  const transport = await webSocketTransport(f.bridge);
  const client = new BridgeClient(transport);
  const orch = new Orchestrator({ client, provider });
  await orch.refreshTools();
  const want = f.agents?.split(",");
  for (const d of DEFAULT_AGENTS) if (!want || want.includes(d.id)) orch.register(d);
  // Approvals are decided in the studio page (approvals panel); stdin approve/deny below stays as a fallback.
  const unlink = linkBridge(orch, transport, out);
  orch.bus.on("approval.requested", (e) => out(`[approval] ${JSON.stringify(e.payload)} -> decide in the studio, or type: approve ${(e.payload as { id: string }).id} | deny ${(e.payload as { id: string }).id}`));
  orch.bus.on("economy.alert", (e) => out(`[economy] ${JSON.stringify(e.payload)}`));
  orch.start();
  const chat = new ChatSensor(client, orch.bus);
  const health = new HealthSensor(client, orch.bus);
  const every = Number(f["poll-ms"] ?? 4000);
  const timer = setInterval(() => { void chat.poll().catch(() => undefined); void health.poll().catch(() => undefined); }, every);
  out(`running ${orch.list().map((d) => d.id).join(", ")}; sensors every ${every}ms`);
  return new Promise<number>((resolve) => {
    proc.stdin.on("data", (d) => {
      const [c, id] = String(d).trim().split(/\s+/);
      const done = (p: Promise<unknown> | void) => void Promise.resolve(p).catch((e) => out(String(e)));
      if (c === "approve" && id) done(orch.approvals.approve(id, "cli").then((r) => out(`executed: ${JSON.stringify(r.result)}`)));
      else if (c === "deny" && id) { try { orch.approvals.deny(id, "cli"); out("denied"); } catch (e) { out(String(e)); } }
      else if (c === "pending") out(JSON.stringify(orch.approvals.pending(), null, 1));
      else if (c === "status") out(JSON.stringify({ agents: orch.status(), economy: orch.economist.status() }, null, 1));
      else if (c === "quit") { clearInterval(timer); unlink(); orch.dispose(); resolve(0); }
    });
  });
}
