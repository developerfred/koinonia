import type { ContentBlock, JsonObject, LlmProvider, LlmRequest, LlmResponse, Usage } from "../types.ts";

export type FakeScript = (req: LlmRequest, callIndex: number) => ContentBlock[] | Promise<ContentBlock[]>;

let idc = 0;
export const toolUse = (name: string, input: JsonObject = {}): ContentBlock => ({ type: "tool_use", id: `toolu_fake_${++idc}`, name, input });
export const say = (text: string): ContentBlock => ({ type: "text", text });

/**
 * Deterministic provider for tests. Give it a script (function of request + call index)
 * or an array of canned turns (last one repeats as plain text "done" afterwards).
 * Records every request in `requests`.
 */
export class FakeProvider implements LlmProvider {
  readonly name = "fake";
  readonly requests: LlmRequest[] = [];
  constructor(private script: FakeScript | ContentBlock[][] = []) {}

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const i = this.requests.length;
    this.requests.push(structuredClone(req));
    const content: ContentBlock[] = Array.isArray(this.script)
      ? (this.script[i] ?? [say("done")])
      : await this.script(req, i);
    const hasTool = content.some((b) => b.type === "tool_use");
    const inputTokens = Math.ceil(JSON.stringify([req.system, req.tools, req.messages]).length / 4);
    const outputTokens = Math.ceil(JSON.stringify(content).length / 4);
    const usage: Usage = { inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 };
    return { content, stopReason: hasTool ? "tool_use" : "end_turn", usage, model: req.model };
  }
}

/** Dry-run provider: records what WOULD be sent and takes no action. */
export class EchoProvider implements LlmProvider {
  readonly name = "dry-run";
  readonly requests: LlmRequest[] = [];
  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.requests.push(req);
    return {
      content: [say("[dry-run] no model call made")],
      stopReason: "end_turn",
      model: req.model,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  }
}
