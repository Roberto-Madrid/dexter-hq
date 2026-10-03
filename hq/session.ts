import { createHmac, timingSafeEqual } from "node:crypto";

export type Session = { email: string; exp: number };

function sign(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function same(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function issueSession(email: string, secret: string, exp: number): string {
  const payload = Buffer.from(JSON.stringify({ email, exp }), "utf8").toString("base64url");
  return `${payload}.${sign(secret, payload)}`;
}

export function readSession(token: string, secret: string, now: number): Session | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  if (!same(mac, sign(secret, payload))) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Session;
    if (typeof parsed.email !== "string" || typeof parsed.exp !== "number") return null;
    if (parsed.exp <= now) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function emailsMatch(left: string, right: string): boolean {
  return same(left.trim().toLowerCase(), right.trim().toLowerCase());
}

export function cookieHeader(token: string, secure: boolean): string {
  const parts = [
    `dexter_session=${token}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    "Max-Age=604800",
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function sessionToken(cookieHeaderValue: string | null): string | null {
  if (!cookieHeaderValue) return null;
  for (const part of cookieHeaderValue.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith("dexter_session=")) return trimmed.slice("dexter_session=".length);
  }
  return null;
}
