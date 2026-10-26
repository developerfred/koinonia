import { systemClock, type Clock } from "./estimate.js";

export type BudgetState = "ok" | "warn" | "degrade" | "stop";

export interface BudgetLimits {
  /** Max tokens (in+out) per session. */
  perSession?: number;
  /** Max tokens in any rolling hour. */
  perHour?: number;
  /** Fractions of the limit. Defaults 0.7 / 0.9 / 1.0. */
  warnAt?: number;
  degradeAt?: number;
  stopAt?: number;
}

export interface BudgetStatus {
  state: BudgetState;
  /** How many tiers to step the router down (0,0,1,2...). */
  degradeSteps: number;
  sessionUsed: number;
  hourUsed: number;
  sessionRatio: number;
  hourRatio: number;
  /** Which limit drives the state. */
  limiting?: "session" | "hour";
  message?: string;
}

export interface BudgetOptions extends BudgetLimits {
  clock?: Clock;
  /** Called when the state changes (e.g. push an alert to the Koinonia panel). */
  onStateChange?: (status: BudgetStatus, previous: BudgetState) => void;
}

const HOUR = 3_600_000;
const ORDER: BudgetState[] = ["ok", "warn", "degrade", "stop"];

export class BudgetTracker {
  private events: Array<{ t: number; n: number }> = [];
  private sessionTotal = 0;
  private last: BudgetState = "ok";
  private clock: Clock;
  constructor(private o: BudgetOptions) {
    this.clock = o.clock ?? systemClock;
  }

  record(tokens: number): BudgetStatus {
    this.events.push({ t: this.clock(), n: tokens });
    this.sessionTotal += tokens;
    return this.status(true);
  }

  /** Would spending `estimated` more tokens cross into stop? Use before calling the LLM. */
  canSpend(estimated = 0): boolean {
    return this.evaluate(estimated).state !== "stop";
  }

  resetSession(): void {
    this.sessionTotal = 0;
  }

  status(notify = false): BudgetStatus {
    const s = this.evaluate(0);
    if (notify && s.state !== this.last) {
      const prev = this.last;
      this.last = s.state;
      this.o.onStateChange?.(s, prev);
    } else if (!notify) {
      this.last = s.state;
    }
    return s;
  }

  private evaluate(extra: number): BudgetStatus {
    const now = this.clock();
    this.events = this.events.filter((e) => now - e.t < HOUR);
    const hourUsed = this.events.reduce((n, e) => n + e.n, 0) + extra;
    const sessionUsed = this.sessionTotal + extra;
    const sr = this.o.perSession ? sessionUsed / this.o.perSession : 0;
    const hr = this.o.perHour ? hourUsed / this.o.perHour : 0;
    const warn = this.o.warnAt ?? 0.7, deg = this.o.degradeAt ?? 0.9, stop = this.o.stopAt ?? 1;
    const classify = (r: number): BudgetState => (r >= stop ? "stop" : r >= deg ? "degrade" : r >= warn ? "warn" : "ok");
    const a = classify(sr), b = classify(hr);
    const state = ORDER.indexOf(a) >= ORDER.indexOf(b) ? a : b;
    const limiting = state === "ok" ? undefined : ORDER.indexOf(a) >= ORDER.indexOf(b) ? "session" : "hour";
    const res: BudgetStatus = {
      state,
      degradeSteps: state === "degrade" ? 1 : state === "stop" ? 2 : 0,
      sessionUsed,
      hourUsed,
      sessionRatio: sr,
      hourRatio: hr,
    };
    if (limiting) {
      res.limiting = limiting;
      res.message = `${limiting} budget at ${Math.round((limiting === "session" ? sr : hr) * 100)}% (${state})`;
    }
    return res;
  }
}
