import { describe, expect, it } from "vitest";
import { chooseBitrateMode, videoConfig } from "../src/encoder-config";
import { DEFAULT_CFG } from "../src/studio";
import { pt } from "../src/ui/i18n";

describe("encoder config", () => {
  it("live config is constant-bitrate, realtime, avc, with the target bitrate", () => {
    const c = videoConfig(DEFAULT_CFG, "prefer-software", "constant") as unknown as Record<string, unknown>;
    expect(c).toMatchObject({ bitrateMode: "constant", latencyMode: "realtime", bitrate: 3_000_000, hardwareAcceleration: "prefer-software", avc: { format: "avc" } });
    expect(DEFAULT_CFG.keyframeSec).toBe(2);
  });
  it("prefers constant when supported, probing with the exact config", async () => {
    const seen: unknown[] = [];
    const m = await chooseBitrateMode(DEFAULT_CFG, "prefer-hardware", async (c) => { seen.push(c); return { supported: true }; });
    expect(m).toBe("constant");
    expect((seen[0] as { bitrateMode: string; hardwareAcceleration: string }).bitrateMode).toBe("constant");
    expect((seen[0] as { hardwareAcceleration: string }).hardwareAcceleration).toBe("prefer-hardware");
  });
  it("falls back to variable when constant is rejected or the probe throws", async () => {
    expect(await chooseBitrateMode(DEFAULT_CFG, "prefer-software", async () => ({ supported: false }))).toBe("variable");
    expect(await chooseBitrateMode(DEFAULT_CFG, "prefer-software", async () => { throw new Error("nope"); })).toBe("variable");
  });
  it("low-bitrate health text explains causes and what to do", () => {
    expect(pt["health.reason.kbps"]).toMatch(/\{v\}/);
    expect(pt["health.reason.kbps"]).toMatch(/cena quase parada/);
    expect(pt["health.reason.kbps"]).toMatch(/painel da plataforma/);
  });
});

import { sanitizeCfg } from "../src/encoder-config";
describe("sanitizeCfg", () => {
  it("coerces fractions, NaN and strings to valid even integers", () => {
    const c = sanitizeCfg({ ...DEFAULT_CFG, width: 1279.6, height: NaN, fps: "30" as never, videoBitrate: -5 });
    expect(c).toMatchObject({ width: 1280, height: 720, fps: 30, videoBitrate: 3_000_000 });
    for (const k of ["width", "height", "fps", "videoBitrate"] as const) expect(Number.isInteger(c[k])).toBe(true);
    expect(sanitizeCfg({ ...DEFAULT_CFG, width: undefined as never }).width).toBe(1280);
    expect(sanitizeCfg({ ...DEFAULT_CFG, width: 1921, height: 1081 })).toMatchObject({ width: 1920, height: 1080 });
  });
});
