import { MODEL_IDS, lowerTier, type Tier } from "./models.js";
import { estimateTokens } from "./estimate.js";

export interface RouteRequest {
  /** The user/event text to handle. */
  text: string;
  /** Explicit task kind, matched against `taskTiers`. */
  task?: string;
  /** Caller override. */
  hint?: Tier;
  /** Number of tools the model may need to chain. */
  toolCount?: number;
  /** Estimated context tokens. */
  contextTokens?: number;
  /** Budget degradation steps (0 = none). */
  degradeSteps?: number;
}

export interface RouterConfig {
  models?: Partial<Record<Tier, string>>;
  /** Fixed tier per task kind, e.g. { "chat-reply": "small", "stream-plan": "large" }. */
  taskTiers?: Record<string, Tier>;
  /** Words/regexes that force a higher tier. */
  complexPatterns?: RegExp[];
  simplePatterns?: RegExp[];
  /** Score thresholds (default 2 -> medium, 4 -> large). */
  mediumAt?: number;
  largeAt?: number;
  /** Never go below this tier even when degrading. Default "small". */
  floor?: Tier;
}

export interface RouteDecision {
  tier: Tier;
  model: string;
  score: number;
  reason: string;
}

const COMPLEX = [/\b(analy[sz]e|plan|design|refactor|debug|compare|strategy|architecture|why|explain|prove|optimi[sz]e|analis[ae]|planej[ae]|compar[ae]|estrat[eé]gia)\b/i, /```/];
const SIMPLE = [/^(hi|hello|oi|ol[aá]|thanks|obrigad[oa]|ok|yes|no|sim|n[aã]o)\b/i, /\b(classify|label|translate|traduz\w*|summar\w+ (this|in one)|extract)\b/i];

export class ModelRouter {
  private models: Record<Tier, string>;
  constructor(private cfg: RouterConfig = {}) {
    this.models = { ...MODEL_IDS, ...cfg.models };
  }

  modelFor(t: Tier): string {
    return this.models[t];
  }

  route(req: RouteRequest): RouteDecision {
    let tier: Tier;
    let score = 0;
    let reason: string;
    if (req.hint) {
      tier = req.hint;
      reason = "hint";
    } else if (req.task && this.cfg.taskTiers?.[req.task]) {
      tier = this.cfg.taskTiers[req.task]!;
      reason = `task:${req.task}`;
    } else {
      const parts: string[] = [];
      const len = estimateTokens(req.text);
      if (len > 400) { score += 2; parts.push("long"); } else if (len > 120) { score += 1; parts.push("medium-length"); }
      if ((req.contextTokens ?? 0) > 20000) { score += 1; parts.push("big-context"); }
      if ((req.toolCount ?? 0) >= 3) { score += 2; parts.push("many-tools"); } else if ((req.toolCount ?? 0) > 0) { score += 1; parts.push("tools"); }
      for (const p of this.cfg.complexPatterns ?? COMPLEX) if (p.test(req.text)) { score += 2; parts.push("complex-keyword"); break; }
      for (const p of this.cfg.simplePatterns ?? SIMPLE) if (p.test(req.text)) { score -= 2; parts.push("simple-keyword"); break; }
      const large = this.cfg.largeAt ?? 4;
      const medium = this.cfg.mediumAt ?? 2;
      tier = score >= large ? "large" : score >= medium ? "medium" : "small";
      reason = "heuristic:" + (parts.join("+") || "default");
    }
    if (req.degradeSteps) {
      const d = lowerTier(tier, req.degradeSteps);
      const floor = this.cfg.floor ?? "small";
      const order = ["small", "medium", "large"];
      // The floor only stops degradation early; it must never raise the tier above the natural one.
      const lowered = order.indexOf(d) < order.indexOf(floor) ? (order.indexOf(floor) < order.indexOf(tier) ? floor : tier) : d;
      if (lowered !== tier) reason += `+degraded(${tier}->${lowered})`;
      tier = lowered;
    }
    return { tier, model: this.models[tier], score, reason };
  }
}
