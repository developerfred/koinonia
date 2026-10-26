export type Verbosity = "minimal" | "normal" | "full";

export interface TrimOptions {
  /** Whitelist of fields; supports dotted paths ("user.name"). Wins over verbosity. */
  fields?: string[];
  verbosity?: Verbosity;
  /** Per-verbosity default field sets. */
  presets?: Partial<Record<Verbosity, string[]>>;
  /** Drop null/undefined/empty-string/empty-array values. Default true. */
  dropEmpty?: boolean;
  /** Truncate long strings (chars). Default: minimal 80, normal 400, full none. */
  maxString?: number;
}

function pick(obj: unknown, paths: string[]): unknown {
  if (Array.isArray(obj)) return obj.map((o) => pick(o, paths));
  if (obj === null || typeof obj !== "object") return obj;
  const out: Record<string, unknown> = {};
  const byHead = new Map<string, string[]>();
  for (const p of paths) {
    const [h, ...rest] = p.split(".");
    if (!h) continue;
    const arr = byHead.get(h) ?? [];
    if (rest.length) arr.push(rest.join("."));
    byHead.set(h, arr);
  }
  for (const [h, rest] of byHead) {
    const v = (obj as Record<string, unknown>)[h];
    if (v === undefined) continue;
    out[h] = rest.length ? pick(v, rest) : v;
  }
  return out;
}

function clean(v: unknown, dropEmpty: boolean, maxString: number | undefined): unknown {
  if (typeof v === "string") return maxString && v.length > maxString ? v.slice(0, maxString - 1) + "…" : v;
  if (Array.isArray(v)) return v.map((x) => clean(x, dropEmpty, maxString));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      const c = clean(x, dropEmpty, maxString);
      if (dropEmpty && (c === null || c === undefined || c === "" || (Array.isArray(c) && c.length === 0))) continue;
      out[k] = c;
    }
    return out;
  }
  return v;
}

/** Trim a tool output by `fields` and/or `verbosity` so only needed data enters context. */
export function trimOutput<T = unknown>(data: T, opts: TrimOptions = {}): unknown {
  const verbosity = opts.verbosity ?? "normal";
  const paths = opts.fields ?? opts.presets?.[verbosity];
  const picked = paths && paths.length ? pick(data, paths) : data;
  const maxString = opts.maxString ?? (verbosity === "minimal" ? 80 : verbosity === "normal" ? 400 : undefined);
  return clean(picked, opts.dropEmpty ?? true, maxString);
}
