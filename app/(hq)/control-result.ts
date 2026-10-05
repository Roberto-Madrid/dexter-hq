export function resumeClearsStop(status: number, body: unknown): boolean {
  if (status < 200 || status >= 300) return false;
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  return (body as { resumed?: unknown }).resumed === true;
}
