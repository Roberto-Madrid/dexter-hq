import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CODEX_ARCHIVE_SHA256,
  CODEX_ARCHIVE_URL,
  CODEX_BINARY_SHA256,
  CODEX_TAR_MEMBER,
  CODEX_VERSION,
  CodexNotReadyError,
  createCodexResolver,
} from "../../hq/codex-bin.ts";

const MEMBER = "codex-x86_64-unknown-linux-musl";
const BINARY = Buffer.from("#!/bin/sh\necho fake-codex\n");
const dirs: string[] = [];

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "codex-bin-test-"));
  dirs.push(dir);
  return dir;
}

function archive(member = MEMBER, body = BINARY): Buffer {
  const src = scratch();
  writeFileSync(join(src, member), body, { mode: 0o755 });
  const out = join(scratch(), "codex.tgz");
  execFileSync("tar", ["-czf", out, "-C", src, member]);
  return readFileSync(out);
}

function fakeFetch(payload: Buffer | (() => Promise<Response>), status = 200) {
  const calls: string[] = [];
  const fn = async (url: string | URL | Request): Promise<Response> => {
    calls.push(String(url));
    if (typeof payload === "function") return payload();
    return new Response(new Uint8Array(payload), { status });
  };
  return { fn: fn as typeof fetch, calls };
}

function resolver(dir: string, tgz: Buffer, fetchImpl: typeof fetch, overrides: Partial<{ archiveSha256: string; binarySha256: string }> = {}) {
  return createCodexResolver({
    dir,
    url: "https://example.invalid/codex.tgz",
    member: MEMBER,
    archiveSha256: overrides.archiveSha256 ?? sha256(tgz),
    binarySha256: overrides.binarySha256 ?? sha256(BINARY),
    fetch: fetchImpl,
  });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("codex runtime resolver", () => {
  it("pins the official release asset by version and sha256", () => {
    expect(CODEX_VERSION).toBe("0.160.0");
    expect(CODEX_ARCHIVE_URL).toBe(
      "https://github.com/openai/codex/releases/download/rust-v0.160.0/codex-x86_64-unknown-linux-musl.tar.gz",
    );
    expect(CODEX_TAR_MEMBER).toBe(MEMBER);
    expect(CODEX_ARCHIVE_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(CODEX_BINARY_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("downloads, verifies, installs an executable, and reuses the cached path", async () => {
    const dir = scratch();
    const tgz = archive();
    const net = fakeFetch(tgz);
    const resolve = resolver(dir, tgz, net.fn);
    const first = await resolve();
    expect(first.startsWith(dir)).toBe(true);
    expect(readFileSync(first)).toEqual(BINARY);
    expect(statSync(first).mode & 0o111).not.toBe(0);
    expect(execFileSync(first, { encoding: "utf8" }).trim()).toBe("fake-codex");
    const second = await resolve();
    expect(second).toBe(first);
    expect(net.calls).toHaveLength(1);
  });

  it("shares one download between concurrent callers", async () => {
    const dir = scratch();
    const tgz = archive();
    const net = fakeFetch(tgz);
    const resolve = resolver(dir, tgz, net.fn);
    const [a, b, c] = await Promise.all([resolve(), resolve(), resolve()]);
    expect(new Set([a, b, c]).size).toBe(1);
    expect(net.calls).toHaveLength(1);
  });

  it("adopts a verified binary already in the cache dir without downloading", async () => {
    const dir = scratch();
    const tgz = archive();
    const warm = fakeFetch(tgz);
    const path = await resolver(dir, tgz, warm.fn)();
    const cold = fakeFetch(tgz);
    expect(await resolver(dir, tgz, cold.fn)()).toBe(path);
    expect(cold.calls).toHaveLength(0);
  });

  it("replaces a cached binary whose hash does not match", async () => {
    const dir = scratch();
    const tgz = archive();
    const path = await resolver(dir, tgz, fakeFetch(tgz).fn)();
    writeFileSync(path, "tampered");
    const net = fakeFetch(tgz);
    expect(await resolver(dir, tgz, net.fn)()).toBe(path);
    expect(net.calls).toHaveLength(1);
    expect(readFileSync(path)).toEqual(BINARY);
  });

  it("refuses an archive whose sha256 does not match the pin and installs nothing", async () => {
    const dir = scratch();
    const tgz = archive();
    const resolve = resolver(dir, tgz, fakeFetch(tgz).fn, { archiveSha256: "0".repeat(64) });
    await expect(resolve()).rejects.toThrow(CodexNotReadyError);
    await expect(resolve()).rejects.toThrow(/codex_not_ready: archive_hash_mismatch/);
    expect(existsSync(dir) ? readdir(dir) : []).toEqual([]);
  });

  it("refuses a binary whose sha256 does not match the pin", async () => {
    const dir = scratch();
    const tgz = archive();
    const resolve = resolver(dir, tgz, fakeFetch(tgz).fn, { binarySha256: "f".repeat(64) });
    await expect(resolve()).rejects.toThrow(/codex_not_ready: binary_hash_mismatch/);
    expect(existsSync(dir) ? readdir(dir) : []).toEqual([]);
  });

  it("is not ready when the download fails, and retries on the next call", async () => {
    const dir = scratch();
    const tgz = archive();
    let attempt = 0;
    const net = fakeFetch(async () => {
      attempt += 1;
      if (attempt === 1) return new Response("gone", { status: 404 });
      if (attempt === 2) throw new Error("network down");
      return new Response(new Uint8Array(tgz), { status: 200 });
    });
    const resolve = resolver(dir, tgz, net.fn);
    await expect(resolve()).rejects.toThrow(/codex_not_ready: download_failed http_404/);
    await expect(resolve()).rejects.toThrow(/codex_not_ready: download_failed/);
    const path = await resolve();
    expect(readFileSync(path)).toEqual(BINARY);
    expect(net.calls).toHaveLength(3);
  });

  it("is not ready when the archive does not contain the pinned member", async () => {
    const dir = scratch();
    const tgz = archive("something-else");
    const resolve = createCodexResolver({
      dir,
      url: "https://example.invalid/codex.tgz",
      member: MEMBER,
      archiveSha256: sha256(tgz),
      binarySha256: sha256(BINARY),
      fetch: fakeFetch(tgz).fn,
    });
    await expect(resolve()).rejects.toThrow(/codex_not_ready: member_missing/);
  });

  it("is not ready when the archive is not gzip", async () => {
    const dir = scratch();
    const junk = Buffer.from("not a tarball");
    const resolve = resolver(dir, junk, fakeFetch(junk).fn);
    await expect(resolve()).rejects.toThrow(/codex_not_ready: extract_failed/);
  });
});

function readdir(dir: string): string[] {
  mkdirSync(dir, { recursive: true });
  return execFileSync("ls", ["-A", dir], { encoding: "utf8" }).split("\n").filter(Boolean);
}
