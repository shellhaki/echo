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
  /** Imported persona, owned by one user. */
  persona: (user: string, slug: string) => `${prefix()}-u-${hash(user)}-p-${slug}`,
  /** Prefix shared by every persona namespace of a user. */
  personaPrefix: (user: string) => `${prefix()}-u-${hash(user)}-p-`,
  /** Everything belonging to a user starts with this. */
  userPrefix: (user: string) => `${prefix()}-u-${hash(user)}-`,
};

export async function recall(
  namespace: string,
  query: string,
  topK = 6,
  maxDistance?: number,
): Promise<RecallMemory[]> {
  try {
    const res = await memwal().recall({ query, namespace, topK, maxDistance });
    return res.results;
  } catch (err) {
    console.error(`[memory] recall failed in ${namespace}:`, err);
    return [];
  }
}

/** Fire-and-forget write. The relayer embeds, encrypts and uploads in the background. */
export async function remember(namespace: string, text: string): Promise<void> {
  try {
    await memwal().remember(text, namespace);
  } catch (err) {
    console.error(`[memory] remember failed in ${namespace}:`, err);
  }
}

export async function rememberMany(namespace: string, texts: string[]): Promise<number> {
  let accepted = 0;
  for (let i = 0; i < texts.length; i += 20) {
    const chunk = texts.slice(i, i + 20).map((text) => ({ text, namespace }));
    try {
      const res = await memwal().rememberBulk(chunk);
      accepted += res.job_ids.length;
    } catch (err) {
      console.error(`[memory] bulk remember failed in ${namespace}:`, err);
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
    const res = await memwal().analyze(text, { namespace });
    return res.facts.map((f) => f.text);
  } catch (err) {
    console.error(`[memory] analyze failed in ${namespace}:`, err);
    return [];
  }
}

/** Namespaces (with memory counts) that belong to one user. */
export async function userNamespaces(user: string) {
  const mine = ns.userPrefix(user);
  return (await allNamespaces()).filter((n) => n.name.startsWith(mine));
}

/** Every namespace on the account. Server-side only: used for blob counting. */
export async function allNamespaces() {
  const out: { name: string; memory_count: number; storage_used: number }[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 50; page++) {
    const res = await memwal().listNamespaces({ cursor, limit: 500 });
    out.push(...res.namespaces);
    if (!res.has_more || !res.next_cursor) break;
    cursor = res.next_cursor;
  }
  return out;
}
