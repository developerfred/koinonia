export type Tier = "small" | "medium" | "large";

export const MODEL_IDS = {
  small: "claude-haiku-5-5",
  medium: "claude-sonnet-5-5",
  large: "claude-opus-5-5",
} as const;

export interface ModelPrice {
  /** USD per million input tokens. */
  input: number;
  /** USD per million output tokens. */
  output: number;
  /** USD per million cache-read tokens (default input * 0.1). */
  cacheRead?: number;
  /** USD per million cache-write tokens (default input * 1.25). */
  cacheWrite?: number;
}

/** PLACEHOLDER prices: override with the real price sheet via config. */
export const DEFAULT_PRICES: Record<string, ModelPrice> = {
  [MODEL_IDS.small]: { input: 1, output: 5 },
  [MODEL_IDS.medium]: { input: 3, output: 15 },
  [MODEL_IDS.large]: { input: 15, output: 75 },
};

export const TIER_ORDER: Tier[] = ["small", "medium", "large"];

export function lowerTier(t: Tier, steps = 1): Tier {
  return TIER_ORDER[Math.max(0, TIER_ORDER.indexOf(t) - steps)]!;
}
