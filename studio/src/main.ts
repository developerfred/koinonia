import "./ui/styles.css";
import { Studio } from "./studio";
import { buildTools } from "./tools/tools";
import { registerAll } from "./tools/webmcp";
import { mountApp } from "./ui/app";

const studio = new Studio();
const reg = registerAll(buildTools(studio));
const app = mountApp(document.getElementById("app")!, studio);

// Os agentes (WebMCP) e o usuário compartilham o mesmo Studio; o tick sincroniza a UI com o que os agentes fizeram.
setInterval(() => app.tick(), 1000);
studio.log = (s) => app.notify("sistema", "warn", s);
document.documentElement.dataset.webmcp = reg.native ? "native" : "polyfill";

// Dev hook até existirem conectores reais de chat (o daemon enviará chat no futuro).
(window as unknown as Record<string, unknown>).koinoniaPushChat = (user: string, text: string, platform = "twitch") =>
  studio.chat.push({ ts: Date.now(), platform, user, text });
