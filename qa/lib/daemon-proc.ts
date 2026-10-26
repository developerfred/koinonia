// Spawns koinonia-d as a black box, configured purely through the env vars documented in daemon/PROTOCOL.md.
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { P } from "./env";
import type { RtmpSink } from "./rtmp-sink";

export interface DaemonOpts {
  sinks?: Record<string, RtmpSink>;            // destination name -> sink (twitch, youtube, or any name)
  keys?: Record<string, string>;               // destination name -> stream key
  env?: Record<string, string>;
  token?: string;
  readyTimeoutMs?: number;
}
export class DaemonNotReady extends Error {}

export interface DaemonHandle {
  port: number;
  proc: ChildProcess;
  log(): string;
  alive(): boolean;
  wsUrl(path?: string): string;
  stop(): Promise<void>;
  clipDir: string;
}

export async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); });
    s.on("error", rej);
  });
}

export function canConnect(port: number, timeout = 300): Promise<boolean> {
  return new Promise((res) => {
    const s = net.connect(port, "127.0.0.1");
    const done = (v: boolean) => { s.destroy(); res(v); };
    s.setTimeout(timeout, () => done(false)); s.on("connect", () => done(true)); s.on("error", () => done(false));
  });
}

export async function startDaemon(o: DaemonOpts = {}): Promise<DaemonHandle> {
  if (!existsSync(P.daemonBin)) throw new DaemonNotReady(`daemon binary not built: ${P.daemonBin} (run: make daemon-build)`);
  const port = await freePort();
  const clipDir = mkdtempSync(join(tmpdir(), "koinonia-clips-"));
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", KOINONIA_PORT: String(port), KOINONIA_CLIP_DIR: clipDir };
  if (o.token) env.KOINONIA_TOKEN = o.token;
  for (const [name, sink] of Object.entries(o.sinks ?? {})) {
    const U = name.toUpperCase();
    const known = name === "twitch" || name === "youtube";
    env[known ? `KOINONIA_${U}_URL` : `KOINONIA_DEST_${U}_URL`] = sink.url("app");
    env[known ? `KOINONIA_${U}_KEY` : `KOINONIA_DEST_${U}_KEY`] = o.keys?.[name] ?? `key_${name}`;
  }
  Object.assign(env, o.env);
  const proc = spawn(P.daemonBin, [], { env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  proc.stdout!.on("data", (d) => { log += d; });
  proc.stderr!.on("data", (d) => { log += d; });
  let exited: number | null | undefined;
  proc.on("exit", (c) => { exited = c ?? -1; });
  const t0 = Date.now();
  const limit = o.readyTimeoutMs ?? 3000;
  while (!(await canConnect(port))) {
    if (exited !== undefined) { rmSync(clipDir, { recursive: true, force: true }); throw new DaemonNotReady(`daemon exited early (code ${exited}); output: ${log.slice(0, 300) || "<none>"}`); }
    if (Date.now() - t0 > limit) { proc.kill("SIGKILL"); rmSync(clipDir, { recursive: true, force: true }); throw new DaemonNotReady(`daemon did not listen on its port within ${limit} ms`); }
    await new Promise((r) => setTimeout(r, 50));
  }
  return {
    port, proc, clipDir, log: () => log, alive: () => exited === undefined,
    wsUrl: (path = "/ingest") => `ws://127.0.0.1:${port}${path}`,
    async stop() {
      if (exited === undefined) {
        proc.kill("SIGTERM");
        await new Promise<void>((r) => { const t = setTimeout(() => { proc.kill("SIGKILL"); r(); }, 2000); proc.on("exit", () => { clearTimeout(t); r(); }); });
      }
      rmSync(clipDir, { recursive: true, force: true });
    },
  };
}

/** Try to start the daemon once; returns {ok:false, reason} rather than throwing, so tests can skip with a reason. */
export async function probeDaemon(): Promise<{ ok: true } | { ok: false; reason: string }> {
  try { const d = await startDaemon({ readyTimeoutMs: Number(process.env.QA_READY_MS ?? 4000) }); await d.stop(); return { ok: true }; }
  catch (e) { return { ok: false, reason: e instanceof DaemonNotReady ? e.message : String(e) }; }
}
