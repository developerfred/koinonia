/** Cheap token estimate (~4 chars/token). Swap for a real tokenizer if needed. */
export function estimateTokens(input: unknown): number {
  if (input === undefined || input === null) return 0;
  const s = typeof input === "string" ? input : JSON.stringify(input) ?? "";
  return Math.ceil(s.length / 4);
}

export type Clock = () => number;
export const systemClock: Clock = () => Date.now();
