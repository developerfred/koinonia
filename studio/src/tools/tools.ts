import type { ChatField } from "../chat/ring";
import type { StudioApi, ToolDef, ToolResult } from "./types";

const ok = (o: unknown): ToolResult => ({ content: [{ type: "text", text: typeof o === "string" ? o : JSON.stringify(o) }] });
const err = (m: string): ToolResult => ({ content: [{ type: "text", text: JSON.stringify({ error: m }) }], isError: true });
const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const CHAT_FIELDS: ChatField[] = ["id", "ts", "platform", "user", "text"];

export function buildTools(api: StudioApi): ToolDef[] {
  const t = (name: string, description: string, properties: Record<string, unknown>, required: string[],
    execute: ToolDef["execute"]): ToolDef =>
    ({ name, description, inputSchema: { type: "object", properties, required, additionalProperties: false }, execute });

  return [
    t("get_chat", "Chat delta since cursor. Returns {c:nextCursor,m:[{u,t,x?}],more?,lost?}. Pass c back as since_cursor.",
      {
        since_cursor: { type: "integer", minimum: 0, description: "0 = from oldest buffered" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        fields: { type: "array", items: { enum: CHAT_FIELDS }, description: "default [user,text]" },
        dedupe: { type: "boolean" },
      }, [], async (a) => {
        const fields = Array.isArray(a.fields) ? (a.fields.filter((f) => CHAT_FIELDS.includes(f as ChatField)) as ChatField[]) : undefined;
        return ok(api.chat.since(num(a.since_cursor, 0), { limit: num(a.limit, 30), fields, dedupe: a.dedupe !== false }));
      }),

    t("create_poll", "Create a poll (2-5 options).",
      { question: { type: "string" }, options: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 5 },
        duration_sec: { type: "integer", minimum: 15, maximum: 1800 } }, ["question", "options"], async (a) => {
        const q = str(a.question);
        const o = Array.isArray(a.options) ? a.options.filter((x): x is string => typeof x === "string") : [];
        if (!q || o.length < 2 || o.length > 5) return err("need question and 2-5 options");
        return ok(api.createPoll(q, o, num(a.duration_sec, 60)));
      }),

    t("pin_message", "Pin a chat message by id (cursor).", { id: { type: "integer" } }, ["id"], async (a) =>
      api.pinMessage(num(a.id, -1)) ? ok({ ok: 1 }) : err("unknown message id")),

    t("switch_scene", "Switch active scene.", { scene: { type: "string" } }, ["scene"], async (a) => {
      const s = str(a.scene);
      return s && api.scenes.switchScene(s) ? ok({ scene: s }) : err(`unknown scene; have ${api.scenes.names().join(",")}`);
    }),

    t("set_layer", "Patch a layer in the current (or given) scene. Coordinates are 0..1 fractions.",
      { id: { type: "string" }, scene: { type: "string" }, x: { type: "number" }, y: { type: "number" }, w: { type: "number" },
        h: { type: "number" }, opacity: { type: "number" }, visible: { type: "boolean" } }, ["id"], async (a) => {
        const { id, scene, ...patch } = a as Record<string, unknown>;
        const clean: Record<string, unknown> = {};
        for (const k of ["x", "y", "w", "h", "opacity"]) if (typeof patch[k] === "number") clean[k] = patch[k];
        if (typeof patch.visible === "boolean") clean.visible = patch.visible;
        const l = api.scenes.setLayer(String(id), clean, str(scene));
        return l ? ok({ id: l.id, x: l.x, y: l.y, w: l.w, h: l.h, o: l.opacity, v: l.visible }) : err("unknown layer");
      }),

    t("set_audio", "Mute/volume for a source (mic|screen).",
      { source: { type: "string" }, muted: { type: "boolean" }, volume: { type: "number", minimum: 0, maximum: 1 } }, ["source"],
      async (a) => api.setAudio(String(a.source), {
        muted: typeof a.muted === "boolean" ? a.muted : undefined,
        volume: typeof a.volume === "number" ? Math.min(1, Math.max(0, a.volume)) : undefined,
      }) ? ok({ ok: 1 }) : err("unknown source")),

    t("set_overlay_text", "Set lower-third overlay text; empty string hides it.", { text: { type: "string", maxLength: 200 } }, ["text"],
      async (a) => { const x = str(a.text) ?? ""; api.scenes.setOverlayText(x.slice(0, 200)); return ok({ ok: 1 }); }),

    t("start_stream", "Start encoding and send to the daemon.", { targets: { type: "array", items: { enum: ["twitch", "youtube"] } } }, [],
      async (a) => ok(await api.startStream(Array.isArray(a.targets) ? (a.targets as string[]) : undefined))),

    t("stop_stream", "Stop streaming.", {}, [], async () => ok(await api.stopStream())),

    t("capture_frame", "Snapshot of the program output as a small JPEG (base64). Costly; use sparingly.",
      { width: { type: "integer", minimum: 64, maximum: 1280 }, quality: { type: "number", minimum: 0.1, maximum: 1 } }, [],
      async (a) => {
        const f = await api.captureFrame({ width: num(a.width, 320), quality: num(a.quality, 0.6) });
        return f ? ok({ mime: f.mime, b64: f.b64 }) : err("no frame (not live or canvas unavailable)");
      }),

    t("mark_highlight", "Mark current moment for the clipper.", { label: { type: "string", maxLength: 80 } }, [],
      async (a) => ok(api.markHighlight(str(a.label)))),

    t("export_clip", "Ask the daemon to export the last N seconds from the circular buffer.",
      { seconds_back: { type: "integer", minimum: 5, maximum: 600 }, title: { type: "string", maxLength: 100 } }, ["seconds_back"],
      async (a) => ok(await api.exportClip(num(a.seconds_back, 30), str(a.title)))),

    t("query_window", "Aggregate a metric (kbps, dropped, fps, chat_rate, ...) over the last N seconds. Alerts that fired since the last call are included in `alerts`.",
      { metric: { type: "string" }, last_sec: { type: "integer", minimum: 1, maximum: 3600 },
        agg: { enum: ["avg", "min", "max", "last", "count", "rate"] } }, [],
      async (a) => {
        const out: Record<string, unknown> = {};
        const m = str(a.metric);
        if (m) Object.assign(out, api.metrics.query(m, num(a.last_sec, 60), (str(a.agg) as never) ?? "avg"));
        else out.metrics = api.metrics.metrics();
        out.state = api.streamState();
        const f = api.metrics.drainFired();
        if (f.length) out.alerts = f;
        return ok(out);
      }),

    t("set_alert", "Alert when metric crosses threshold (edge-triggered; reported via query_window). Use remove_id to delete.",
      { metric: { type: "string" }, op: { enum: ["gt", "lt"] }, threshold: { type: "number" }, remove_id: { type: "integer" } }, [],
      async (a) => {
        if (typeof a.remove_id === "number") return ok({ removed: api.metrics.removeAlert(a.remove_id) });
        const m = str(a.metric);
        if (!m || typeof a.threshold !== "number") return err("metric and threshold required");
        return ok({ id: api.metrics.addAlert(m, a.op === "lt" ? "lt" : "gt", a.threshold) });
      }),
  ];
}
