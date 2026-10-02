// Style memory: how someone talks, not what they said.
//
// Memories in a style namespace are plain text with a tag prefix so one
// namespace can hold every kind:
//   [trait]   a short observation, e.g. "Greets people with 'yo!'"
//   [example] a real message (or "them -> reply" pair) to use as a few-shot sample
//   [card]    a persona summary written at import time

import { generateJson } from "./llm";
import { recall, rememberMany } from "./memory";

export const TAG = { trait: "[trait] ", example: "[example] ", card: "[card] " } as const;

export type StyleContext = { traits: string[]; examples: string[]; card?: string };

const STYLE_QUERY =
  "how they talk: greetings, slang, catchphrases, tone, emoji, capitalisation, punctuation, message length";

// The relayer allows ~60 requests/min per key for the whole app, so a style
// profile is fetched once and reused for a minute (and dropped on new writes).
const STYLE_TTL_MS = 60_000;
const gs = globalThis as unknown as { __ebStyle?: Map<string, { ctx: StyleContext; at: number }> };
const styleCache: Map<string, { ctx: StyleContext; at: number }> = (gs.__ebStyle ??= new Map());

export async function loadStyle(namespace: string): Promise<StyleContext> {
  const hit = styleCache.get(namespace);
  if (hit && Date.now() - hit.at < STYLE_TTL_MS) return hit.ctx;
  const ctx = parseStyle(await recall(namespace, STYLE_QUERY, 20));
  styleCache.set(namespace, { ctx, at: Date.now() });
  if (styleCache.size > 5_000) styleCache.clear();
  return ctx;
}

function parseStyle(memories: { text: string }[]): StyleContext {
  const seen = new Set<string>();
  const ctx: StyleContext = { traits: [], examples: [] };
  for (const m of memories) {
    if (seen.has(m.text)) continue;
    seen.add(m.text);
    if (m.text.startsWith(TAG.trait)) ctx.traits.push(m.text.slice(TAG.trait.length));
    else if (m.text.startsWith(TAG.example)) ctx.examples.push(m.text.slice(TAG.example.length));
    else if (m.text.startsWith(TAG.card) && !ctx.card) ctx.card = m.text.slice(TAG.card.length);
  }
  ctx.traits = ctx.traits.slice(0, 10);
  ctx.examples = ctx.examples.slice(0, 8);
  return ctx;
}

export function forgetStyleCache(namespace: string) {
  styleCache.delete(namespace);
}

type StyleScan = { traits?: string[]; keep_as_example?: boolean };

/**
 * Look at one user message and store what it reveals about their voice.
 * Runs after the reply is sent, so it never slows the chat down.
 */
export async function learnStyle(namespace: string, message: string): Promise<string[]> {
  const text = message.trim();
  if (text.length < 2 || text.length > 600) return [];

  const known = await loadStyle(namespace);
  const scan = await generateJson<StyleScan>(
    `You study HOW a person writes so an assistant can imitate them. Ignore WHAT they say.
Given one message and the traits already known, return:
- "traits": 0-2 NEW, specific, reusable style traits not already covered (e.g. "Opens with 'yo!'", "Writes in all lowercase", "Uses 'fr' and 'ngl'", "Ends sentences with 🔥", "Very short replies, rarely more than 8 words"). Never record facts about their life here.
- "keep_as_example": true if this message is a good, distinctive sample of their voice (has personality, slang, a greeting, a catchphrase). false for plain or generic messages, questions that are only facts, or anything containing secrets.
Return {"traits": [], "keep_as_example": false} when nothing stands out.`,
    `Known traits:\n${known.traits.map((t) => `- ${t}`).join("\n") || "(none yet)"}\n\nMessage:\n${text}`,
  ).catch((err) => {
    console.error("[style] scan failed:", err);
    return null;
  });
  if (!scan) return [];

  const stored: string[] = [];
  for (const trait of (scan.traits ?? []).slice(0, 2)) {
    const t = String(trait).trim();
    if (!t || known.traits.some((k) => k.toLowerCase() === t.toLowerCase())) continue;
    stored.push(TAG.trait + t);
  }
  if (scan.keep_as_example && !known.examples.includes(text)) stored.push(TAG.example + text);
  if (stored.length) {
    // One bulk request instead of one per memory.
    await rememberMany(namespace, stored);
    forgetStyleCache(namespace);
  }
  return stored;
}

/** Prompt section that makes the model sound like the user (mirror mode). */
export function mirrorInstructions(style: StyleContext, strength: number): string {
  if (!style.traits.length && !style.examples.length) {
    return "You haven't learned how this user talks yet. Use a relaxed, friendly tone.";
  }
  const level =
    strength >= 80
      ? "Fully adopt their voice, as if you were them texting a friend."
      : strength >= 40
        ? "Clearly adopt their voice while staying helpful."
        : "Add light touches of their voice.";
  return `Talk the way THIS USER talks. ${level}
Match their greetings, slang, catchphrases, casing, punctuation, emoji use and typical message length.
Style traits learned from them:
${style.traits.map((t) => `- ${t}`).join("\n") || "- (none yet)"}
Real messages they wrote (imitate the voice, do not repeat the content):
${style.examples.map((e) => `> ${e}`).join("\n") || "> (none yet)"}
Style never overrides accuracy: facts you state must stay correct.`;
}

/** Prompt section for chatting as an imported persona. */
export function personaInstructions(name: string, style: StyleContext): string {
  return `You are role-playing as ${name}, an AI persona built from ${name}'s real chat messages (shared with their consent).
Reply exactly as ${name} would text: same tone, slang, nicknames, emoji, length and quirks. Stay in character.
If asked directly whether you are an AI, say you're an AI persona of ${name}.
Persona profile:
${style.card ?? "(no profile)"}
Traits:
${style.traits.map((t) => `- ${t}`).join("\n") || "- (none)"}
Real exchanges (format: "them: ... || ${name}: ..."). Copy the voice, not the content:
${style.examples.map((e) => `> ${e}`).join("\n") || "> (none)"}`;
}
