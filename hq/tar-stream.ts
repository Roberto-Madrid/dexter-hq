/**
 * Minimal streaming ustar/pax/GNU tar reader. It never touches the filesystem: `select` decides, per regular file,
 * whether to receive its bytes. Used by the Codex resolver (one pinned member) and the handoff source (repo docs).
 */
import { Writable } from "node:stream";

export class TarFormatError extends Error {}

const MAX_META_BYTES = 1024 * 1024;

function cstr(block: Buffer, start: number, length: number): string {
  const slice = block.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString("utf8");
}

function octal(field: Buffer): number {
  if (field[0] & 0x80) {
    let value = 0;
    for (let i = 1; i < field.length; i += 1) value = value * 256 + field[i];
    return value;
  }
  const text = field.toString("ascii").replace(/[\0 ]+/g, " ").trim();
  if (!/^[0-7]*$/.test(text)) throw new TarFormatError("bad_octal");
  return text ? parseInt(text, 8) : 0;
}

function checksumOk(block: Buffer): boolean {
  let sum = 0;
  for (let i = 0; i < 512; i += 1) sum += i >= 148 && i < 156 ? 32 : block[i];
  return sum === octal(block.subarray(148, 156));
}

function paxPath(data: Buffer): string | null {
  let offset = 0;
  let path: string | null = null;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const length = Number(data.subarray(offset, space).toString("ascii"));
    if (!Number.isInteger(length) || length <= 0) break;
    const record = data.subarray(space + 1, offset + length - 1).toString("utf8");
    const eq = record.indexOf("=");
    if (eq > 0 && record.slice(0, eq) === "path") path = record.slice(eq + 1);
    offset += length;
  }
  return path;
}

/** Receives one selected file's bytes in order; `end` runs once its last byte arrived. */
export type TarSink = { data(part: Buffer): void; end?(): void };
/** Called for each regular file (`name` without a leading `./`); return null to skip it. May throw to abort. */
export type TarSelect = (name: string, size: number) => TarSink | null;

export class TarReader extends Writable {
  private pending = Buffer.alloc(0);
  private state: "header" | "data" | "pad" | "end" = "header";
  private remaining = 0;
  private padding = 0;
  private current: "member" | "meta" | "skip" = "skip";
  private sink: TarSink | null = null;
  private metaKind = "";
  private meta: Buffer[] = [];
  private nextName: string | null = null;
  private readonly select: TarSelect;

  constructor(select: TarSelect) {
    super();
    this.select = select;
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    try {
      this.consume(chunk);
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }

  override _final(callback: (error?: Error | null) => void): void {
    callback(this.state === "data" || (this.state === "pad" && this.padding > 0) ? new TarFormatError("truncated") : null);
  }

  private consume(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length && this.state !== "end") {
      if (this.state === "data") {
        const n = Math.min(this.remaining, chunk.length - offset);
        this.onData(chunk.subarray(offset, offset + n));
        this.remaining -= n;
        offset += n;
        if (this.remaining === 0) this.finishEntry();
      } else if (this.state === "pad") {
        const n = Math.min(this.padding, chunk.length - offset);
        this.padding -= n;
        offset += n;
        if (this.padding === 0) this.state = "header";
      } else {
        const n = Math.min(512 - this.pending.length, chunk.length - offset);
        this.pending = Buffer.concat([this.pending, chunk.subarray(offset, offset + n)]);
        offset += n;
        if (this.pending.length === 512) {
          const block = this.pending;
          this.pending = Buffer.alloc(0);
          this.header(block);
        }
      }
    }
  }

  private header(block: Buffer): void {
    if (block.every((byte) => byte === 0)) {
      this.state = "end";
      return;
    }
    if (!checksumOk(block)) throw new TarFormatError("bad_header");
    const size = octal(block.subarray(124, 136));
    const type = block[156] === 0 ? "0" : String.fromCharCode(block[156]);
    let name = cstr(block, 0, 100);
    if (cstr(block, 257, 6).startsWith("ustar")) {
      const prefix = cstr(block, 345, 155);
      if (prefix) name = `${prefix}/${name}`;
    }
    if (this.nextName !== null && type !== "x" && type !== "L") {
      name = this.nextName;
      this.nextName = null;
    }
    name = name.replace(/^(\.\/)+/, "");
    this.padding = (512 - (size % 512)) % 512;
    this.sink = null;
    if (type === "x" || type === "L") {
      if (size > MAX_META_BYTES) throw new TarFormatError("meta_too_large");
      this.current = "meta";
      this.metaKind = type;
      this.meta = [];
    } else if (type === "0" || type === "7") {
      this.sink = this.select(name, size);
      this.current = this.sink ? "member" : "skip";
    } else {
      this.current = "skip";
    }
    this.remaining = size;
    if (size === 0) this.finishEntry();
    else this.state = "data";
  }

  private onData(part: Buffer): void {
    if (this.current === "member") this.sink?.data(part);
    else if (this.current === "meta") this.meta.push(Buffer.from(part));
  }

  private finishEntry(): void {
    if (this.current === "meta") {
      const data = Buffer.concat(this.meta);
      this.nextName = this.metaKind === "L" ? cstr(data, 0, data.length) : (paxPath(data) ?? this.nextName);
      this.meta = [];
    }
    if (this.current === "member") this.sink?.end?.();
    this.sink = null;
    this.current = "skip";
    this.state = this.padding > 0 ? "pad" : "header";
  }
}
