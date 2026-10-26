// Black-box fuzz of the daemon's ingest path over WebSocket: seeded mutations of golden frames and random bytes.
// Invariants: the daemon never crashes, never wedges (a new session can always be opened afterwards), memory does not explode.
import { describe, it, expect } from "vitest";
import { RtmpSink } from "../lib/rtmp-sink";
import { startDaemon, probeDaemon } from "../lib/daemon-proc";
import { openStudio, goldenSession } from "../lib/ws-studio";
import { mulberry32 } from "../lib/prng.mjs";
import { fixture } from "../lib/env";
import type { Golden } from "../lib/golden";

const probe = await probeDaemon();
if (!probe.ok) console.warn(`[qa] SKIP daemon black-box fuzz: ${probe.reason}`);
const ITER = Number(process.env.QA_FUZZ_ITERS ?? 150);

describe.skipIf(!probe.ok)("daemon black-box fuzz", () => {
  it(`survives ${ITER} mutated/random sessions`, async () => {
    const golden = fixture<Golden>("protocol/golden.json");
    const corpus = [...golden.valid, ...golden.invalid].map((v) => Buffer.from(v.bytes, "hex"));
    const sink = await new RtmpSink().listen();
    const daemon = await startDaemon({ sinks: { twitch: sink } });
    const rnd = mulberry32(1234);
    try {
      for (let n = 0; n < ITER; n++) {
        let s;
        for (let attempt = 0; ; attempt++) {
          try { s = await openStudio(daemon.wsUrl()); break; }
          catch (e: any) { if (e.statusCode === 409 && attempt < 50) { await new Promise((r) => setTimeout(r, 40)); continue; } throw e; }
        }
        // sometimes start with a sane preamble so mutations hit the deeper (muxing) paths
        if (rnd() < 0.6) for (const f of goldenSession().slice(0, 3)) s.send(f.bytes);
        const k = 1 + Math.floor(rnd() * 8);
        for (let i = 0; i < k; i++) {
          let b = Buffer.from(corpus[Math.floor(rnd() * corpus.length)]!);
          const mode = rnd();
          if (mode < 0.5 && b.length) b[Math.floor(rnd() * b.length)] = Math.floor(rnd() * 256);
          else if (mode < 0.7) b = b.subarray(0, Math.floor(rnd() * b.length));
          else if (mode < 0.85) b = Buffer.concat([b, Buffer.from(Array.from({ length: Math.floor(rnd() * 64) }, () => Math.floor(rnd() * 256)))]);
          else b = Buffer.from(Array.from({ length: Math.floor(rnd() * 200) }, () => Math.floor(rnd() * 256)));
          if (s.ws.readyState === s.ws.OPEN) s.send(b);
        }
        s.close();
        await Promise.race([s.closed, new Promise((r) => setTimeout(r, 500))]);
        expect(daemon.alive(), `daemon died on iteration ${n}; log: ${daemon.log().slice(-500)}`).toBe(true);
      }
      const s = await openStudio(daemon.wsUrl());
      await s.waitStatus((x) => x.type === "ready", 3000, "ready after fuzz");
      s.close();
    } finally { await daemon.stop(); await sink.close(); }
  }, 120_000);
});
