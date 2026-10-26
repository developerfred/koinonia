// Minimal Node shims so we need no @types/node (keeps deps tiny).
declare module "node:fs" {
  export function readFileSync(path: string, enc: string): string;
}
