// Minimal Node shims so we need no @types/node (keeps deps tiny).
declare module "node:fs" {
  export function readFileSync(path: string, enc: string): string;
}

// Loose shims for the bridge server (no @types/node). Only what bridge-server.ts touches.
declare class Buffer extends Uint8Array {
  static alloc(n: number): Buffer;
  static from(x: string | ArrayLike<number> | Uint8Array, enc?: string): Buffer;
  static concat(l: Uint8Array[]): Buffer;
  toString(enc?: string): string;
  subarray(a?: number, b?: number): Buffer;
  readUInt16BE(o: number): number;
  readBigUInt64BE(o: number): bigint;
  writeUInt16BE(v: number, o?: number): number;
  writeBigUInt64BE(v: bigint, o: number): number;
}
declare module "node:crypto" {
  export function createHash(a: string): { update(s: string): { digest(enc: string): string } };
  export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
}
declare module "node:stream" {
  export interface Duplex {
    write(d: Uint8Array | string): boolean;
    end(d?: Uint8Array | string): void;
    destroy(): void;
    destroyed: boolean;
    on(ev: "data", f: (d: Buffer) => void): this;
    on(ev: "close", f: () => void): this;
    on(ev: "error", f: (e: unknown) => void): this;
  }
}
declare module "node:net" {
  export interface AddressInfo { address: string; port: number }
}
declare module "node:http" {
  import type { Duplex } from "node:stream";
  export interface IncomingMessage { url?: string; headers: Record<string, string | string[] | undefined> }
  export interface ServerResponse { writeHead(c: number, h?: Record<string, string>): void; end(s?: string): void }
  export interface Server {
    on(ev: "upgrade", f: (req: IncomingMessage, sock: Duplex) => void): this;
    once(ev: "error", f: (e: unknown) => void): this;
    listen(port: number, host: string, cb: () => void): this;
    address(): unknown;
    close(cb: () => void): void;
  }
  export function createServer(h: (req: IncomingMessage, res: ServerResponse) => void): Server;
}
