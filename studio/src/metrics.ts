export interface Sample { t: number; v: number }
export type AlertOp = "gt" | "lt";
export interface Alert { id: number; metric: string; op: AlertOp; threshold: number; fired: boolean }
export interface Fired { alert: number; metric: string; v: number; t: number }

/** Per-metric time series ring + threshold alerts. Clock is injectable for tests. */
export class MetricsStore {
  private series = new Map<string, Sample[]>();
  private alerts: Alert[] = [];
  private firedQ: Fired[] = [];
  private nextAlert = 1;
  constructor(private cap = 3600, private now: () => number = () => Date.now()) {}

  push(metric: string, v: number, t = this.now()): void {
    let s = this.series.get(metric);
    if (!s) this.series.set(metric, (s = []));
    s.push({ t, v });
    if (s.length > this.cap) s.splice(0, s.length - this.cap);
    for (const a of this.alerts) {
      if (a.metric !== metric) continue;
      const hit = a.op === "gt" ? v > a.threshold : v < a.threshold;
      if (hit && !a.fired) this.firedQ.push({ alert: a.id, metric, v, t });
      a.fired = hit; // edge-triggered; re-arms when back in range
    }
  }

  metrics(): string[] { return [...this.series.keys()]; }

  query(metric: string, lastSec: number, agg: "avg" | "min" | "max" | "last" | "count" | "rate" = "avg") {
    const s = this.series.get(metric) ?? [];
    const from = this.now() - lastSec * 1000;
    const w = s.filter((x) => x.t >= from);
    if (!w.length) return { n: 0 } as { n: number; v?: number };
    const vs = w.map((x) => x.v);
    let v: number;
    switch (agg) {
      case "min": v = Math.min(...vs); break;
      case "max": v = Math.max(...vs); break;
      case "last": v = vs[vs.length - 1]!; break;
      case "count": v = vs.length; break;
      case "rate": v = vs.reduce((a, b) => a + b, 0) / Math.max(lastSec, 1); break;
      default: v = vs.reduce((a, b) => a + b, 0) / vs.length;
    }
    return { n: w.length, v: Math.round(v * 100) / 100 };
  }

  addAlert(metric: string, op: AlertOp, threshold: number): number {
    const id = this.nextAlert++;
    this.alerts.push({ id, metric, op, threshold, fired: false });
    return id;
  }
  removeAlert(id: number): boolean {
    const n = this.alerts.length;
    this.alerts = this.alerts.filter((a) => a.id !== id);
    return this.alerts.length !== n;
  }
  /** drain alerts that fired since last call (delta semantics) */
  drainFired(): Fired[] { const f = this.firedQ; this.firedQ = []; return f; }
}
