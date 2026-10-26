// A fake daemon ingest endpoint (WebSocket only) that validates what the studio sends against the golden protocol.
import { WebSocketServer } from "ws";
import { decode, type RefFrame } from "./golden";

export interface Received { bytes: Uint8Array; frame?: RefFrame; error?: string }
export class FakeDaemonWs {
  wss!: WebSocketServer;
  received: Received[] = [];
  connections = 0;
  async listen(port: number): Promise<this> {
    this.wss = new WebSocketServer({ host: "127.0.0.1", port, path: "/ingest" });
    this.wss.on("connection", (ws) => {
      this.connections++;
      ws.send(JSON.stringify({ type: "ready", version: 1 }));
      ws.on("message", (d, isBin) => {
        if (!isBin) { this.received.push({ bytes: new Uint8Array(), error: "text message" }); return; }
        const bytes = new Uint8Array(d as Buffer);
        try { this.received.push({ bytes, frame: decode(bytes) }); } catch (e) { this.received.push({ bytes, error: (e as Error).message }); }
      });
    });
    await new Promise<void>((r) => this.wss.once("listening", () => r()));
    return this;
  }
  async close() { for (const c of this.wss.clients) c.terminate(); await new Promise<void>((r) => this.wss.close(() => r())); }
}
