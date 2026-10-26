import { it } from "vitest";
import { readJson } from "./env";
import { join } from "node:path";
import { QA } from "./env";

const gaps: Record<string, string> = readJson(join(QA, "known-gaps.json")).gaps;

/** `gap(id)(name, fn)`: it.fails() while id is listed in known-gaps.json, a normal `it` otherwise. */
export function gap(id: string) {
  return gaps[id] ? ((name: string, fn: () => unknown) => it.fails(`[known gap: ${id}] ${name}`, fn as never)) : it;
}
