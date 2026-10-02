// Small in-memory sliding-window limiter. Per server instance only, which is
// enough to stop one person from burning LLM credits and Walrus storage.

const g = globalThis as unknown as { __ebRate?: Map<string, number[]> };
const hits: Map<string, number[]> = (g.__ebRate ??= new Map());

export const LIMITS = {
  chat: { max: 20, windowMs: 60_000 },
  voice: { max: 10, windowMs: 60_000 },
  import: { max: 3, windowMs: 60 * 60_000 },
} as const;

/** Returns seconds to wait, or 0 if the action is allowed (and records it). */
export function rateLimit(key: string, kind: keyof typeof LIMITS): number {
  const { max, windowMs } = LIMITS[kind];
  const now = Date.now();
  const id = `${kind}:${key}`;
  const recent = (hits.get(id) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= max) {
    hits.set(id, recent);
    return Math.ceil((windowMs - (now - recent[0])) / 1000);
  }
  recent.push(now);
  hits.set(id, recent);
  if (hits.size > 10_000) hits.clear();
  return 0;
}
