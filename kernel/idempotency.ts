function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function idempotencyKey(parts: readonly string[]): Promise<string> {
  const data = new TextEncoder().encode(parts.join("\u001f"));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return hex(digest);
}

export function remember<T>(
  store: Map<string, T>,
  key: string,
  create: () => T,
): { value: T; duplicate: boolean } {
  if (store.has(key)) return { value: store.get(key) as T, duplicate: true };
  const value = create();
  store.set(key, value);
  return { value, duplicate: false };
}
