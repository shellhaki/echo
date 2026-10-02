// Import someone's chat messages and turn them into a persona the user can
// talk to. Supports WhatsApp .txt exports, Telegram Desktop result.json
// exports, and plain "Name: message" text.

import { randomBytes } from "node:crypto";
import { generateJson } from "./llm";
import { ns, rememberMany, userNamespaces } from "./memory";
import { TAG } from "./style";

export type ChatLine = { sender: string; text: string };

const SKIP = [
  /<media omitted>/i,
  /\b(image|video|audio|sticker|gif|document) omitted\b/i,
  /this message was deleted/i,
  /you deleted this message/i,
  /messages and calls are end-to-end encrypted/i,
  /^null$/i,
  /<this message was edited>/i,
];

// "[31/12/2023, 21:41:05] " (iOS) or "12/31/23, 9:41 PM - " (Android)
const TIMESTAMP =
  /^‎?\[?\d{1,4}[./-]\d{1,2}[./-]\d{1,4},?\s+\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AaPp]\.?\s?[Mm]\.?)?\]?\s*(?:-\s*)?/;

export function parseChat(raw: string): ChatLine[] {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    const fromJson = parseTelegramJson(trimmed);
    if (fromJson) return fromJson;
  }

  const lines: ChatLine[] = [];
  for (const rawLine of trimmed.split(/\r?\n/)) {
    const line = rawLine.replace(/[‎‏]/g, "");
    const hadTimestamp = TIMESTAMP.test(line);
    const rest = line.replace(TIMESTAMP, "");
    const m = rest.match(/^([^:\n]{1,40}):\s(.*)$/);
    if (m) {
      lines.push({ sender: m[1].trim(), text: m[2].trim() });
    } else if (!hadTimestamp && lines.length && rest.trim()) {
      // Continuation of a multi-line message.
      lines[lines.length - 1].text += "\n" + rest.trim();
    }
  }
  return lines.filter((l) => l.text && !SKIP.some((r) => r.test(l.text)));
}

function parseTelegramJson(raw: string): ChatLine[] | null {
  try {
    const data = JSON.parse(raw) as {
      messages?: { type?: string; from?: string; text?: string | (string | { text?: string })[] }[];
    };
    if (!Array.isArray(data.messages)) return null;
    return data.messages
      .filter((m) => m.type === "message" && m.from)
      .map((m) => ({
        sender: m.from!,
        text: Array.isArray(m.text)
          ? m.text.map((p) => (typeof p === "string" ? p : (p.text ?? ""))).join("")
          : (m.text ?? ""),
      }))
      .filter((l) => l.text.trim());
  } catch {
    return null;
  }
}

export function senders(lines: ChatLine[]): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const l of lines) counts.set(l.sender, (counts.get(l.sender) ?? 0) + 1);
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

/** Group consecutive lines by sender, then pair "what they were told" -> "what target replied". */
export function buildPairs(lines: ChatLine[], target: string): { them: string; reply: string }[] {
  const turns: ChatLine[] = [];
  for (const l of lines) {
    const last = turns[turns.length - 1];
    if (last && last.sender === l.sender) last.text += "\n" + l.text;
    else turns.push({ ...l });
  }
  const pairs: { them: string; reply: string }[] = [];
  for (let i = 1; i < turns.length; i++) {
    if (turns[i].sender === target && turns[i - 1].sender !== target) {
      pairs.push({ them: clip(turns[i - 1].text, 200), reply: clip(turns[i].text, 300) });
    }
  }
  return pairs;
}

function clip(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

const EMOJI = /\p{Extended_Pictographic}/u;

/** Prefer short, characterful replies; keep some randomness so we cover range. */
function pickExamples(pairs: { them: string; reply: string }[], max: number) {
  const scored = pairs.map((p) => {
    let score = Math.random();
    if (EMOJI.test(p.reply)) score += 1;
    if (p.reply.length >= 4 && p.reply.length <= 160) score += 1;
    if (/[!?]{2,}|haha|lol|lmao|omg|bro|babe|yo\b/i.test(p.reply)) score += 0.5;
    return { p, score };
  });
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((s) => s.p);
}

type Card = { card?: string; traits?: string[] };

export async function importPersona(opts: {
  user: string;
  raw: string;
  target: string;
  maxExamples?: number;
}): Promise<{ slug: string; name: string; stored: number; pairs: number; messages: number }> {
  const lines = parseChat(opts.raw);
  const theirs = lines.filter((l) => l.sender === opts.target);
  if (theirs.length < 5) {
    throw new Error(`Found only ${theirs.length} messages from "${opts.target}". Need at least 5.`);
  }
  const pairs = buildPairs(lines, opts.target);
  const examples = pickExamples(pairs, opts.maxExamples ?? 40);

  const sample = theirs
    .slice(-400)
    .sort(() => Math.random() - 0.5)
    .slice(0, 150)
    .map((l) => `- ${clip(l.text, 200)}`)
    .join("\n");

  const card = await generateJson<Card>(
    `You build a texting-style profile of one person from their real messages, so an AI can reply like them.
Return {"card": "...", "traits": ["...", ...]}.
"card": 4-8 sentences covering tone, energy, humour, how they greet and sign off, pet names/nicknames they use, emoji habits, typical length, spelling/casing quirks, languages mixed, and topics they bring up.
"traits": 6-12 short, specific, imitable traits (e.g. "Calls people 'babe'", "Never uses capital letters", "Sends 😭 when laughing").
Describe style only. Do not include addresses, phone numbers, passwords or other sensitive data.`,
    `Messages from ${opts.target}:\n${sample}`,
  );

  const slug = `${opts.target.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "persona"}-${randomBytes(2).toString("hex")}`;
  const namespace = ns.persona(opts.user, slug);

  const texts = [
    ...(card?.card ? [TAG.card + card.card] : []),
    ...(card?.traits ?? []).slice(0, 12).map((t) => TAG.trait + t),
    ...examples.map((p) => `${TAG.example}them: ${p.them} || ${opts.target}: ${p.reply}`),
  ];
  const stored = await rememberMany(namespace, texts);

  return { slug, name: opts.target, stored, pairs: pairs.length, messages: theirs.length };
}

export async function listPersonas(user: string): Promise<{ slug: string; memories: number }[]> {
  const pre = ns.personaPrefix(user);
  return (await userNamespaces(user))
    .filter((n) => n.name.startsWith(pre))
    .map((n) => ({ slug: n.name.slice(pre.length), memories: n.memory_count }));
}
