import { FakeProvider } from "../src/providers/fake.ts";
import type { FakeScript } from "../src/providers/fake.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import type { OrchestratorOptions } from "../src/orchestrator.ts";
import { MockWebMcp, studioLikeMock } from "../src/webmcp.ts";
import type { AgentDefinition } from "../src/agent.ts";
import type { Clock } from "../src/types.ts";
import type { ContentBlock } from "../src/types.ts";

export class ManualClock implements Clock {
  constructor(public t = 1_000_000) {}
  now() { return this.t; }
  advance(ms: number) { this.t += ms; }
}

export async function setup(defs: AgentDefinition[], script: FakeScript | ContentBlock[][] = [], opts: Partial<OrchestratorOptions> = {}, client: MockWebMcp = studioLikeMock()) {
  const clock = new ManualClock();
  const provider = new FakeProvider(script);
  const orch = new Orchestrator({ client, provider, clock, timers: false, ...opts });
  await orch.refreshTools();
  for (const d of defs) orch.register(d);
  orch.start();
  return { orch, provider, client, clock };
}

/** get_chat mock that serves queued deltas. */
export function chatFeed(client: MockWebMcp) {
  const q: { c: number; m: Record<string, unknown>[] }[] = [];
  client.register("get_chat", () => q.shift() ?? { c: 0, m: [] });
  return {
    push(c: number, texts: [string, string][]) { q.push({ c, m: texts.map(([u, t], i) => ({ i: c - texts.length + i + 1, u, t })) }); },
  };
}
