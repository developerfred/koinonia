import { Studio } from "./studio";
import { buildTools } from "./tools/tools";
import { registerAll } from "./tools/webmcp";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const studio = new Studio();
const reg = registerAll(buildTools(studio));

$("support").textContent = studio.supportMessage;
const status = () => {
  $("status").textContent = JSON.stringify({
    webmcp: reg.native ? "native" : "polyfill", tools: reg.names.length, state: studio.streamState(),
    scene: studio.scenes.current, chatCursor: studio.chat.cursor,
  }, null, 1);
};
setInterval(status, 1000); status();

const preview = $<HTMLVideoElement>("preview");
studio.log = (s) => { $("status").textContent += "\n" + s; };
const guard = (f: () => Promise<unknown>) => () => f().catch((e) => ($("support").textContent = String(e)));
$("cam").onclick = guard(async () => { preview.srcObject = await studio.enableCamera(); });
$("scr").onclick = guard(async () => { await studio.enableScreen(); studio.scenes.switchScene("screen"); });
$("go").onclick = guard(async () => { const r = await studio.startStream(); $("support").textContent = r.detail ?? r.state; });
$("stop").onclick = guard(async () => { await studio.stopStream(); });

// Dev hook until real Twitch/YouTube chat connectors exist (daemon will push chat in future).
(window as unknown as Record<string, unknown>).koinoniaPushChat = (user: string, text: string, platform = "twitch") =>
  studio.chat.push({ ts: Date.now(), platform, user, text });
