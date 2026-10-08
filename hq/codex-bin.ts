/**
 * Runtime resolver for the Codex CLI binary used by path B (CEO chat and the Critic seat).
 *
 * The binary is ~276 MB. It is not traced into any function bundle (function storage is capped);
 * instead it is fetched on first use from the pinned official release asset, verified against the
 * pinned archive and binary sha256 values below, and cached under /tmp for warm invocations.
 * Any failure is fail-closed: callers get CodexNotReadyError and never run an unverified binary.
 */
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, chmodSync, closeSync, existsSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { createGunzip } from "node:zlib";
import { TarFormatError, TarReader } from "./tar-stream.ts";

export const CODEX_VERSION = "0.160.0";
export const CODEX_ARCHIVE_URL =
  "https://github.com/openai/codex/releases/download/rust-v0.160.0/codex-x86_64-unknown-linux-musl.tar.gz";
/** sha256 of the release asset; matches the digest GitHub publishes for it. */
export const CODEX_ARCHIVE_SHA256 = "306865417d4ee7a927785852910a527f41e1e159add390ac5ae3accb67d44a13";
/** sha256 of the extracted binary; identical to the binary previously vendored from the npm linux-x64 package. */
export const CODEX_BINARY_SHA256 = "12eb3e81114588aca3b7998f4f19e8997b056aca08e57a7ca7c8a3ec8c652aad";
export const CODEX_TAR_MEMBER = "codex-x86_64-unknown-linux-musl";
export const CODEX_CACHE_DIR = "/tmp/dexter-codex";

const DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_MEMBER_BYTES = 1024 * 1024 * 1024;

export class CodexNotReadyError extends Error {
  readonly reason: string;
  constructor(reason: string, options?: { cause?: unknown }) {
    super(`codex_not_ready: ${reason}`, options);
    this.name = "CodexNotReadyError";
    this.reason = reason;
  }
}

export type CodexResolverOptions = {
  dir: string;
  url: string;
  member: string;
  archiveSha256: string;
  binarySha256: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function install(options: CodexResolverOptions, finalPath: string): Promise<void> {
  mkdirSync(options.dir, { recursive: true, mode: 0o755 });
  const temp = join(options.dir, `.codex-${process.pid}-${randomBytes(6).toString("hex")}.partial`);
  try {
    let response: Response;
    try {
      response = await (options.fetch ?? fetch)(options.url, {
        redirect: "follow",
        signal: AbortSignal.timeout(options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS),
      });
    } catch (error) {
      throw new CodexNotReadyError("download_failed", { cause: error });
    }
    if (!response.ok || !response.body) throw new CodexNotReadyError(`download_failed http_${response.status}`);

    const archiveHash = createHash("sha256");
    const binaryHash = createHash("sha256");
    const fd = openSync(temp, "w", 0o600);
    let found = false;
    const writer = new TarReader((name, size) => {
      if (name !== options.member) return null;
      if (found) throw new TarFormatError("duplicate_member");
      if (size > MAX_MEMBER_BYTES) throw new TarFormatError("member_too_large");
      found = true;
      return {
        data(part) {
          binaryHash.update(part);
          let written = 0;
          while (written < part.length) written += writeSync(fd, part, written, part.length - written);
        },
      };
    });
    try {
      await pipeline(
        Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>),
        new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            archiveHash.update(chunk);
            callback(null, chunk);
          },
        }),
        createGunzip(),
        writer,
      );
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      const extract = error instanceof TarFormatError || (typeof code === "string" && code.startsWith("Z_"));
      throw new CodexNotReadyError(extract ? "extract_failed" : "download_failed", { cause: error });
    } finally {
      closeSync(fd);
    }
    if (archiveHash.digest("hex") !== options.archiveSha256) throw new CodexNotReadyError("archive_hash_mismatch");
    if (!found) throw new CodexNotReadyError("member_missing");
    if (binaryHash.digest("hex") !== options.binarySha256) throw new CodexNotReadyError("binary_hash_mismatch");
    chmodSync(temp, 0o755);
    renameSync(temp, finalPath);
  } catch (error) {
    if (error instanceof CodexNotReadyError) throw error;
    throw new CodexNotReadyError("install_failed", { cause: error });
  } finally {
    rmSync(temp, { force: true });
  }
}

/**
 * Returns a function that resolves the absolute path of a verified Codex binary.
 * Concurrent callers share one download; a verified path is reused for the life of the process;
 * a failed attempt is not cached, so the next call retries.
 */
export function createCodexResolver(options: CodexResolverOptions): () => Promise<string> {
  const finalPath = join(options.dir, `codex-${options.binarySha256.slice(0, 16)}`);
  let ready: string | null = null;
  let inflight: Promise<string> | null = null;

  async function resolveOnce(): Promise<string> {
    if (existsSync(finalPath)) {
      let cached = "";
      try {
        cached = await fileSha256(finalPath);
      } catch {
        cached = "";
      }
      if (cached === options.binarySha256) {
        chmodSync(finalPath, 0o755);
        return finalPath;
      }
      rmSync(finalPath, { force: true });
    }
    await install(options, finalPath);
    return finalPath;
  }

  return () => {
    if (ready && existsSync(ready)) return Promise.resolve(ready);
    ready = null;
    if (!inflight) {
      inflight = resolveOnce()
        .then((path) => {
          ready = path;
          return path;
        })
        .finally(() => {
          inflight = null;
        });
    }
    return inflight;
  };
}

let liveResolver: (() => Promise<string>) | null = null;

/** Live resolver used by path B. Linux x64 only, which is what the deployed functions run on. */
export function resolveCodexBin(): Promise<string> {
  // dexter-shortcut: only the linux x64 musl asset is pinned (the deployed function platform); upgrade path: pin per-platform assets if path B ever runs elsewhere.
  if (process.platform !== "linux" || process.arch !== "x64") {
    return Promise.reject(new CodexNotReadyError("unsupported_platform"));
  }
  liveResolver ??= createCodexResolver({
    dir: CODEX_CACHE_DIR,
    url: CODEX_ARCHIVE_URL,
    member: CODEX_TAR_MEMBER,
    archiveSha256: CODEX_ARCHIVE_SHA256,
    binarySha256: CODEX_BINARY_SHA256,
  });
  return liveResolver();
}
