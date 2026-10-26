import { compactChat } from "../../tokens/src/index.ts";
import type { EventBus } from "./eventbus.ts";
import type { Clock } from "./types.ts";
import { systemClock } from "./types.ts";
import type { WebMcpClient } from "./webmcp.ts";

export interface ChatSensorOptions {
  clock?: Clock;
  /** Max messages pulled per poll. */
  limit?: number;
  /** Spike if rate > factor * baseline AND >= minMessages in the window. */
  spikeFactor?: number;
  minMessages?: number;
  /** EWMA smoothing for the baseline rate (msg/s). */
  alpha?: number;
  /** Floor for baseline so a dead chat does not "spike" on 3 messages. */
  minBaseline?: number;
}

/**
 * Non-LLM sensor: polls get_chat by cursor (delta only), publishes `chat.batch`, and detects
 * rate spikes statistically -> `chat.spike`. Spike detection is free; only the Clipper that
 * reacts to it costs tokens.
 */
export class ChatSensor {
  cursor = 0;
  baseline = 0;
  private lastPoll: number;
  private clock: Clock;
  private warm = 0;
  constructor(private client: WebMcpClient, private bus: EventBus, private o: ChatSensorOptions = {}) {
    this.clock = o.clock ?? systemClock;
    this.lastPoll = this.clock.now();
  }

  async poll(): Promise<{ count: number; spike: boolean }> {
    const r = await this.client.callTool("get_chat", { since_cursor: this.cursor, limit: this.o.limit ?? 100, fields: ["id", "user", "text"], dedupe: true });
    const now = this.clock.now();
    const dt = Math.max(0.001, (now - this.lastPoll) / 1000);
    this.lastPoll = now;
    if (r.isError) return { count: 0, spike: false };
    let d: { c?: number; m?: { i?: number; u?: string; t?: string; x?: number }[] };
    try { d = JSON.parse(r.content.map((c) => c.text).join("")); } catch { return { count: 0, spike: false }; }
    if (typeof d.c === "number") this.cursor = Math.max(this.cursor, d.c);
    const msgs = (d.m ?? []).map((m) => ({ id: m.i, user: String(m.u ?? "?"), text: String(m.t ?? ""), count: m.x ?? 1 }));
    const count = msgs.reduce((n, m) => n + m.count, 0);
    const rate = count / dt;

    const a = this.o.alpha ?? 0.2;
    const floor = this.o.minBaseline ?? 0.2;
    const isSpike = this.warm >= 3 && count >= (this.o.minMessages ?? 8) && rate > (this.o.spikeFactor ?? 3) * Math.max(this.baseline, floor);
    // do not let a spike poison the baseline
    if (!isSpike) this.baseline = this.warm === 0 ? rate : this.baseline * (1 - a) + rate * a;
    this.warm++;

    if (msgs.length) await this.bus.emit("chat.batch", { messages: msgs, cursor: this.cursor });
    if (isSpike) {
      const sample = compactChat(msgs.map((m) => ({ id: String(m.id ?? ""), user: m.user, text: m.text })), { limit: 8 }).entries
        .map((e) => ({ user: e.user, text: e.text, count: e.count }));
      await this.bus.emit("chat.spike", { rate, baseline: this.baseline, windowSec: Math.round(dt), count, sample });
    }
    return { count, spike: isSpike };
  }
}

/** Polls query_window and publishes `health.alert` when the page reports fired alerts. */
export class HealthSensor {
  constructor(private client: WebMcpClient, private bus: EventBus) {}
  async poll(): Promise<{ alerts: unknown[] }> {
    const r = await this.client.callTool("query_window", {});
    if (r.isError) return { alerts: [] };
    try {
      const d = JSON.parse(r.content.map((c) => c.text).join("")) as { alerts?: unknown[]; state?: string };
      if (d.alerts?.length) await this.bus.emit("health.alert", { alerts: d.alerts, state: d.state });
      else await this.bus.emit("health.ok", { state: d.state });
      return { alerts: d.alerts ?? [] };
    } catch { return { alerts: [] }; }
  }
}
