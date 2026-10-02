// Thin wrapper around the official Walrus Memory SDK.
//
// Isolation model: one MemWal account for the whole app, one namespace per
// user (and per persona). Raw channel IDs (Telegram IDs, cookie UUIDs) are
// salted + hashed before they become part of a namespace, so namespaces never
// leak who a user is, and a user can only ever reach namespaces derived from
// their own identity.

import { createHash } from "node:crypto";
import { MemWal, MemWalMock } from "@mysten-incubation/memwal";
import type { RecallMemory } from "@mysten-incubation/memwal";
import { env, usingMockMemory } from "./env";

type Client = MemWal | MemWalMock;

// Survive Next.js hot reloads (and keep the mock's in-memory data alive).
const g = globalThis as unknown as { __walbuddyMemwal?: Client };

export function memwal(): Client {
  if (!g.__walbuddyMemwal) {
    g.__walbuddyMemwal = usingMockMemory()
      ? MemWalMock.create({ namespace: "walbuddy-mock" })
      : MemWal.create({
          key: env.memwal.key!,
          accountId: env.memwal.accountId!,
          serverUrl: env.memwal.serverUrl,
          namespace: `wb-${env.appEnv}-default`,
        });
  }
  return g.__walbuddyMemwal;
}

/** Stable, opaque id for a user on a channel, e.g. userKey("tg", 12345). */
export function userKey(channel: "web" | "tg" | "cli", id: string | number): string {
  return `${channel}:${id}`;
}

function hash(value: string): string {
  return createHash("sha256").update(env.userIdSalt).update(value).digest("hex").slice(0, 20);
}

const prefix = () => `wb-${env.appEnv}`;

export const ns = {
  /** Durable facts about the user (name, projects, preferences...). */
  facts: (user: string) => `${prefix()}-u-${hash(user)}-facts`,
  /** How the user talks: style traits + example messages. */
  style: (user: string) => `${prefix()}-u-${hash(user)}-style`,
  /** Small per-user settings (e.g. Telegram mode) so they survive restarts. */
  settings: (user: string) => `${prefix()}-u-${hash(user)}-settings`,
  /** Imported persona, owned by one user. */
  persona: (user: string, slug: string) => `${prefix()}-u-${hash(user)}-p-${slug}`,
  /** Prefix shared by every persona namespace of a user. */
  personaPrefix: (user: string) => `${prefix()}-u-${hash(user)}-p-`,
  /** Everything belonging to a user starts with this. */
  userPrefix: (user: string) => `${prefix()}-u-${hash(user)}-`,
};

// Write-through cache. The relayer needs from a few seconds (single writes) to
// a couple of minutes (bulk imports) before a new memory shows up in recall.
// Until then, recall also returns what this server instance wrote recently,
// so a fact told a moment ago or a freshly imported persona works immediately.
const RECENT_TTL_MS = 10 * 60 * 1000;
const RECENT_MAX = 40;
const gr = globalThis as unknown as { __ebRecent?: Map<string, { text: string; at: number }[]> };
const recentWrites: Map<string, { text: string; at: number }[]> = (gr.__ebRecent ??= new Map());

function addRecent(namespace: string, texts: string[]) {
  const now = Date.now();
  const list = (recentWrites.get(namespace) ?? []).filter((r) => now - r.at < RECENT_TTL_MS);
  for (const text of texts) list.push({ text, at: now });
  recentWrites.set(namespace, list.slice(-RECENT_MAX));
}

function getRecent(namespace: string): string[] {
  const now = Date.now();
  return (recentWrites.get(namespace) ?? [])
    .filter((r) => now - r.at < RECENT_TTL_MS)
    .map((r) => r.text)
    .reverse(); // newest first
}

type RelayerError = { status?: number; retryAfterSeconds?: number; message?: string };

function describe(err: unknown): string {
  const e = err as RelayerError;
  return e?.status ? `${e.status} ${e.message?.slice(0, 160)}` : String(err);
}

/**
 * Writes run in the background, so they can afford to wait out the relayer's
 * per-key rate limit (HTTP 429) instead of silently dropping a memory.
 */
async function withRetry<T>(what: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const e = err as RelayerError;
      if (e?.status !== 429 || attempt >= 2) throw err;
      const waitS = Math.min(e.retryAfterSeconds ?? 5, 15);
      console.warn(`[memory] ${what} rate-limited, retrying in ${waitS}s`);
      await new Promise((r) => setTimeout(r, waitS * 1000));
    }
  }
}

export async function recall(
  namespace: string,
  query: string,
  topK = 6,
  opts: { maxDistance?: number; sort?: "relevance" | "recent" } = {},
): Promise<RecallMemory[]> {
  let results: RecallMemory[] = [];
  try {
    results = (await memwal().recall({ query, namespace, topK, ...opts })).results;
  } catch (err) {
    console.error(`[memory] recall failed in ${namespace}: ${describe(err)}`);
  }
  const seen = new Set(results.map((r) => r.text));
  const pending = getRecent(namespace)
    .filter((text) => !seen.has(text))
    .map((text) => ({ blob_id: "", text, distance: 0 }));
  if (!pending.length) return results;
  // For "recent" the just-written entries are by definition the newest.
  return opts.sort === "recent" ? [...pending, ...results].slice(0, topK) : [...results, ...pending];
}

/** Fire-and-forget write. The relayer embeds, encrypts and uploads in the background. */
export async function remember(namespace: string, text: string): Promise<void> {
  try {
    await withRetry("remember", () => memwal().remember(text, namespace));
    addRecent(namespace, [text]);
  } catch (err) {
    console.error(`[memory] remember failed in ${namespace}: ${describe(err)}`);
  }
}

export async function rememberMany(namespace: string, texts: string[]): Promise<number> {
  let accepted = 0;
  for (let i = 0; i < texts.length; i += 20) {
    const chunk = texts.slice(i, i + 20).map((text) => ({ text, namespace }));
    try {
      const res = await withRetry("rememberBulk", () => memwal().rememberBulk(chunk));
      accepted += res.job_ids.length;
      addRecent(namespace, chunk.map((c) => c.text));
    } catch (err) {
      console.error(`[memory] bulk remember failed in ${namespace}: ${describe(err)}`);
    }
  }
  return accepted;
}

/**
 * Let the relayer's extractor pull durable facts out of a message and store
 * only those. This is what keeps us from blindly saving every chat line.
 */
export async function analyzeFacts(namespace: string, text: string): Promise<string[]> {
  try {
    const res = await withRetry("analyze", () => memwal().analyze(text, { namespace }));
    const facts = res.facts.map((f) => f.text);
    addRecent(namespace, facts);
    return facts;
  } catch (err) {
    console.error(`[memory] analyze failed in ${namespace}: ${describe(err)}`);
    return [];
  }
}

/** Namespaces (with memory counts) that belong to one user. */
export async function userNamespaces(user: string) {
  const mine = ns.userPrefix(user);
  return (await allNamespaces()).filter((n) => n.name.startsWith(mine));
}

let nsCache: { at: number; data: Promise<NamespaceRow[]> } | undefined;

/** Every namespace on the account (cached 20s to spare the relayer's rate limit). */
export function allNamespaces(): Promise<NamespaceRow[]> {
  if (!nsCache || Date.now() - nsCache.at > 20_000) {
    const data = fetchAllNamespaces();
    nsCache = { at: Date.now(), data };
    data.catch(() => (nsCache = undefined));
  }
  return nsCache.data;
}

type NamespaceRow = { name: string; memory_count: number; storage_used: number };

async function fetchAllNamespaces() {
  const out: NamespaceRow[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 50; page++) {
    const res = await memwal().listNamespaces({ cursor, limit: 500 });
    out.push(...res.namespaces);
    if (!res.has_more || !res.next_cursor) break;
    cursor = res.next_cursor;
  }
  return out;
}
