/** Minimal WebSocket shape (browser, Node 22+, or a mock). */
export interface WsLike {
  send(data: string): void;
  close(code?: number): void;
  onopen: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number }) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
}
export type WsFactory = (url: string) => WsLike;

/** Test double that records frames and lets tests drive the server side. */
export class MockSocket implements WsLike {
  sent: string[] = [];
  closed = false;
  onopen: WsLike["onopen"] = null;
  onmessage: WsLike["onmessage"] = null;
  onclose: WsLike["onclose"] = null;
  onerror: WsLike["onerror"] = null;
  constructor(readonly url: string) {}
  send(d: string): void { if (this.closed) throw new Error("closed"); this.sent.push(d); }
  close(code = 1000): void { if (!this.closed) { this.closed = true; queueMicrotask(() => this.onclose?.({ code })); } }
  // server-side drivers
  serverOpen(): void { this.onopen?.(); }
  serverSend(data: string): void { this.onmessage?.({ data }); }
  serverClose(code = 1006): void { this.closed = true; this.onclose?.({ code }); }
}
