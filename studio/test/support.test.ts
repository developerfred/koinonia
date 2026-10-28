import { afterEach, describe, expect, it } from "vitest";
import { codecFailureMessage, detectBrowser, probeCodecs } from "../src/support";

const UA_CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
const UA_FF = "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0";
const g = globalThis as Record<string, unknown>;
afterEach(() => { delete g.VideoEncoder; delete g.AudioEncoder; });

describe("codec failure messages", () => {
  it("names the browser, the failed probe and what to do", async () => {
    g.VideoEncoder = { isConfigSupported: async () => ({ supported: false }) };
    g.AudioEncoder = { isConfigSupported: async () => ({ supported: true }) };
    const p = await probeCodecs(1280, 720, 30);
    expect(p.video).toBe(false);
    const m = codecFailureMessage(p, UA_FF)!;
    expect(m).toContain("Firefox 130");
    expect(m).toContain("H.264");
    expect(m).toContain("hardware failed");
    expect(m).toContain("Google Chrome");
    expect(m).toContain("desktop app");
  });
  it("reports thrown probe errors and a missing encoder API", async () => {
    g.VideoEncoder = { isConfigSupported: async () => { throw new Error("NotSupportedError: boom"); } };
    const p = await probeCodecs(1280, 720, 30);
    expect(codecFailureMessage(p, UA_CHROME)).toContain("boom");
    delete g.VideoEncoder;
    expect((await probeCodecs(1280, 720, 30)).errors).toContain("encoder API missing");
  });
  it("AAC failure is distinct; success returns null; software-only counts as supported", async () => {
    g.VideoEncoder = { isConfigSupported: async (c: { hardwareAcceleration: string }) => ({ supported: c.hardwareAcceleration === "prefer-software" }) };
    g.AudioEncoder = { isConfigSupported: async () => ({ supported: false }) };
    const p = await probeCodecs(1280, 720, 30);
    expect(p.video).toBe(true);
    expect(codecFailureMessage(p, UA_CHROME)).toMatch(/AAC encoding is unavailable in Chrome/);
    g.AudioEncoder = { isConfigSupported: async () => ({ supported: true }) };
    expect(codecFailureMessage(await probeCodecs(1280, 720, 30), UA_CHROME)).toBeNull();
  });
  it("detects browsers", () => {
    expect(detectBrowser(UA_CHROME)).toContain("Chrome-based browser 152");
    expect(detectBrowser(UA_CHROME + " Edg/152.0")).toContain("Microsoft Edge 152");
    expect(detectBrowser("")).toBe("unknown browser");
  });
});
