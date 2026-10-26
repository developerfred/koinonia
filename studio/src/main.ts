import "./ui/styles.css";
import { Studio } from "./studio";
import { buildTools } from "./tools/tools";
import { registerAll } from "./tools/webmcp";
import { mountApp } from "./ui/app";
import { PageBridge } from "./bridge";
import { TwitchConnector, UnifiedChat } from "../../connectors/src/index";

/**
 * URL parameters (all optional, all local):
 *   ?daemon=ws://127.0.0.1:7878/ingest  &token=<KOINONIA_TOKEN>
 *   ?bridge=ws://127.0.0.1:9333         agents bridge (agents/ `koinonia-agents bridge`)
 *   ?twitch=<channel>                   anonymous read-only Twitch chat into the chat panel
 *   ?w=1920&h=1080&fps=30&vkbps=6000    encode settings
 */
const q = new URLSearchParams(location.search);
const n = (k: string) => { const v = Number(q.get(k)); return Number.isFinite(v) && v > 0 ? v : undefined; };
const studio = new Studio({
  daemonUrl: q.get("daemon") ?? undefined, token: q.get("token") ?? undefined,
  cfg: { width: n("w"), height: n("h"), fps: n("fps"), videoBitrate: n("vkbps") ? n("vkbps")! * 1000 : undefined } as never,
});
const tools = buildTools(studio);
const reg = registerAll(tools);
const app = mountApp(document.getElementById("app")!, studio);

// Os agentes (WebMCP) e o usuário compartilham o mesmo Studio; o tick sincroniza a UI com o que os agentes fizeram.
setInterval(() => { studio.approvals.sweep(); app.tick(); }, 1000);
studio.log = (s) => app.notify("sistema", "warn", s);
document.documentElement.dataset.webmcp = reg.native ? "native" : "polyfill";

const bridgeUrl = q.get("bridge");
if (bridgeUrl) {
  const b = new PageBridge(bridgeUrl, () => tools, studio);
  b.onState = (s) => { document.documentElement.dataset.bridge = s; };
  b.start();
}

const channel = q.get("twitch");
if (channel) {
  const unified = new UnifiedChat();
  const tw = new TwitchConnector({ channel, createSocket: (u) => new WebSocket(u) as never });
  unified.add(tw);
  studio.attachChat(unified, { twitch: tw as never });
  void unified.start().then((r) => { if (r.twitch !== "ok") studio.log("chat twitch: " + r.twitch); });
}

// Dev/test hooks: push chat without a connector; expose the studio for external measurement (qa, benchmarks).
(window as unknown as Record<string, unknown>).koinoniaPushChat = (user: string, text: string, platform = "twitch") =>
  studio.chat.push({ ts: Date.now(), platform, user, text });
(window as unknown as Record<string, unknown>).__koinonia = studio;
