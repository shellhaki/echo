// Telegram bot. The same bot runs two ways:
//   - webhook in production (src/app/api/telegram/route.ts)
//   - long polling locally (npm run telegram)
//
// Everything is stateless across server instances: long-term memory, the
// chosen mode and imported personas all live in Walrus Memory. Only the
// short-term chat history is kept in process memory.

import { Bot, InlineKeyboard, type Context } from "grammy";
import { respond, personaName, type ChatTurn, type Mode } from "./brain";
import { env } from "./env";
import { httpFetch } from "./http";
import { makeLinkCode } from "./identity";
import { ns, recall, remember, userKey, userNamespaces } from "./memory";
import { importPersona, listPersonas, parseChat, senders } from "./persona";
import { rateLimit } from "./rate-limit";
import { transcribe } from "./voice/stt";

type Session = { mode: Mode; persona?: string; history: ChatTurn[] };
type Schedule = (task: () => Promise<unknown>) => void;

const g = globalThis as unknown as { __ebTgSessions?: Map<number, Session> };
const sessions = (g.__ebTgSessions ??= new Map());

const user = (ctx: Context) => userKey("tg", ctx.from!.id);

/** Load the session, restoring the saved mode from Walrus after a cold start. */
async function session(ctx: Context): Promise<Session> {
  const id = ctx.from!.id;
  let s = sessions.get(id);
  if (s) return s;
  s = { mode: "assistant", history: [] };
  const [saved] = await recall(ns.settings(user(ctx)), "telegram mode setting", 1, { sort: "recent" });
  const m = saved?.text.match(/^\[settings\] mode=(assistant|mirror|persona)(?: persona=(\S+))?/);
  if (m) {
    s.mode = m[1] as Mode;
    s.persona = m[2];
  }
  sessions.set(id, s);
  return s;
}

async function setMode(ctx: Context, mode: Mode, persona?: string) {
  const s = await session(ctx);
  s.mode = mode;
  s.persona = persona;
  s.history = [];
  await remember(ns.settings(user(ctx)), `[settings] mode=${mode}${persona ? ` persona=${persona}` : ""}`);
}

const HELP = [
  "I'm EchoBot: an assistant with memory stored on Walrus.",
  "Tell me about yourself and I'll remember it, even in a brand-new chat.",
  "",
  "Modes",
  "/assistant: normal assistant",
  "/mirror: I learn how you text and start sounding like you",
  "/personas: personas you've imported",
  "/talkto <name>: chat with a persona",
  "",
  "Persona import: send me a WhatsApp export (.txt) or Telegram export (result.json) and pick who to learn from.",
  "",
  "Other",
  "/new: fresh conversation (I still remember you)",
  "/memories: what I've stored for you",
  "/link: share one memory with the web app and CLI",
  "",
  "Voice notes work too 🎙",
].join("\n");

export function createBot(schedule: Schedule) {
  if (!env.telegram.token) throw new Error("TELEGRAM_BOT_TOKEN is not set.");
  const bot = new Bot(env.telegram.token);

  // Private chats only: in groups every member would share one context.
  bot.use(async (ctx, next) => {
    if (ctx.chat && ctx.chat.type !== "private") {
      if (ctx.message?.text?.startsWith("/start")) {
        await ctx.reply("I only work in private chats. Message me directly!");
      }
      return;
    }
    if (!ctx.from) return;
    await next();
  });

  bot.command(["start", "help"], (ctx) => ctx.reply(HELP));

  bot.command("mirror", async (ctx) => {
    await setMode(ctx, "mirror");
    await ctx.reply("Mirror mode on 🪞 The more you chat, the more I sound like you.");
  });

  bot.command(["assistant", "stop"], async (ctx) => {
    await setMode(ctx, "assistant");
    await ctx.reply("Back to normal assistant mode.");
  });

  bot.command("new", async (ctx) => {
    (await session(ctx)).history = [];
    await ctx.reply("Fresh conversation started. Long-term memory is still on Walrus, so ask me what I remember.");
  });

  bot.command("personas", async (ctx) => {
    const list = await listPersonas(user(ctx));
    if (!list.length) {
      return ctx.reply("No personas yet. Send me a WhatsApp (.txt) or Telegram (result.json) chat export to create one.");
    }
    const kb = new InlineKeyboard();
    list.slice(0, 10).forEach((p) => kb.text(`Talk to ${personaName(p.slug)}`, `talk:${p.slug}`).row());
    return ctx.reply("Your personas:", { reply_markup: kb });
  });

  bot.command("talkto", async (ctx) => {
    const arg = ctx.match.trim().toLowerCase();
    const list = await listPersonas(user(ctx));
    const hit = list.find((p) => p.slug === arg || personaName(p.slug).toLowerCase() === arg) ?? (list.length === 1 && !arg ? list[0] : undefined);
    if (!hit) return ctx.reply("Persona not found. Try /personas.");
    await setMode(ctx, "persona", hit.slug);
    await ctx.reply(`Now chatting with ${personaName(hit.slug)} (AI persona). /stop to exit.`);
  });

  bot.callbackQuery(/^talk:(.+)$/, async (ctx) => {
    const slug = ctx.match[1];
    await ctx.answerCallbackQuery();
    const list = await listPersonas(user(ctx));
    if (!list.some((p) => p.slug === slug)) return ctx.reply("That persona no longer exists.");
    await setMode(ctx, "persona", slug);
    await ctx.reply(`Now chatting with ${personaName(slug)} (AI persona). Say hi! /stop to exit.`);
  });

  bot.command("link", (ctx) =>
    ctx.reply(
      `Paste this code in the web app or CLI within 15 minutes to share one memory across all of them:\n\n${makeLinkCode(ctx.from!.id)}\n\nDon't share it with anyone else.`,
    ),
  );

  bot.command("memories", async (ctx) => {
    const [facts, spaces, s] = await Promise.all([
      recall(ns.facts(user(ctx)), "everything about the user: name, work, projects, preferences, goals", 10),
      userNamespaces(user(ctx)).catch(() => []),
      session(ctx),
    ]);
    const style = spaces.filter((n) => n.name.endsWith("-style")).reduce((a, n) => a + n.memory_count, 0);
    const personas = spaces.filter((n) => n.name.includes("-p-")).length;
    if (!facts.length && !style && !personas) return ctx.reply("Nothing stored yet. Tell me about yourself!");
    return ctx.reply(
      [
        facts.length ? "What I remember about you:" : "No facts about you yet.",
        ...facts.map((f) => `• ${f.text}`),
        "",
        `Style notes: ${style} · Personas: ${personas}`,
        `Current mode: ${s.mode === "persona" && s.persona ? `persona (${personaName(s.persona)})` : s.mode}`,
        "",
        "All of it is encrypted and stored on Walrus.",
      ].join("\n"),
    );
  });

  // ---- Persona import: send a chat export as a file ----
  // The flow is stateless: buttons sit on a reply to the uploaded file, so each
  // step re-reads the file via reply_to_message instead of server state.

  bot.on("message:document", async (ctx) => {
    const doc = ctx.message.document;
    const name = doc.file_name ?? "";
    if (!/\.(txt|json)$/i.test(name) && !/text\/plain|application\/json/.test(doc.mime_type ?? "")) {
      return ctx.reply("Send a WhatsApp export (.txt, without media) or a Telegram export (result.json) to build a persona.");
    }
    if ((doc.file_size ?? 0) > 4 * 1024 * 1024) return ctx.reply("That file is too big (max 4 MB).");
    const raw = await downloadText(ctx, doc.file_id);
    if (raw === null) return ctx.reply("Couldn't download that file. Try again.");
    const found = senders(parseChat(raw)).slice(0, 8);
    if (!found.length) return ctx.reply("I couldn't find any messages in that file. Is it a chat export?");
    const kb = new InlineKeyboard();
    found.forEach((s, i) => kb.text(`${s.name} (${s.count})`, `imp:${i}`).row());
    return ctx.reply("Who should I learn to talk like?", {
      reply_markup: kb,
      reply_parameters: { message_id: ctx.message.message_id },
    });
  });

  bot.callbackQuery(/^imp:(\d+)$/, async (ctx) => {
    const target = await importTarget(ctx, Number(ctx.match[1]));
    await ctx.answerCallbackQuery();
    if (!target) return ctx.reply("I lost track of that file. Please send it again.");
    await ctx.editMessageText(
      `Before I learn from ${target}: did ${target} agree to have their messages used for an AI persona? It will always be labeled as AI.`,
      { reply_markup: new InlineKeyboard().text("Yes, they agreed", `ok:${ctx.match[1]}`).text("Cancel", "cancel") },
    );
  });

  bot.callbackQuery("cancel", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText("Cancelled. Nothing was stored.");
  });

  bot.callbackQuery(/^ok:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const wait = rateLimit(user(ctx), "import");
    if (wait) return ctx.reply(`Too many imports. Try again in ${Math.ceil(wait / 60)} min.`);
    const fileId = ctx.callbackQuery.message?.reply_to_message?.document?.file_id;
    const raw = fileId ? await downloadText(ctx, fileId) : null;
    const target = raw ? senders(parseChat(raw))[Number(ctx.match[1])]?.name : undefined;
    if (!raw || !target) return ctx.reply("I lost track of that file. Please send it again.");
    await ctx.editMessageText(`Studying how ${target} texts and saving it to Walrus… (about 20 seconds)`);
    try {
      const res = await importPersona({ user: user(ctx), raw, target });
      await setMode(ctx, "persona", res.slug);
      await ctx.reply(
        `Done! Learned ${target}'s style from ${res.messages} messages and stored ${res.stored} memories on Walrus.\n\nYou're now chatting with ${personaName(res.slug)} (AI persona). Say hi! /stop to exit.`,
      );
    } catch (err) {
      console.error("[telegram] import failed:", err);
      await ctx.reply(err instanceof Error ? err.message : "Import failed. Try again.");
    }
  });

  // ---- Chat ----

  bot.on("message:text", async (ctx) => {
    if (ctx.message.text.startsWith("/")) return ctx.reply("Unknown command. Try /help.");
    await answer(ctx, ctx.message.text, schedule);
  });

  bot.on(["message:voice", "message:audio", "message:video_note"], async (ctx) => {
    const wait = rateLimit(user(ctx), "voice");
    if (wait) return ctx.reply(`Slow down a little. Try again in ${wait}s.`);
    const media = ctx.message.voice ?? ctx.message.audio ?? ctx.message.video_note;
    if (media && "duration" in media && media.duration > 300) return ctx.reply("Voice messages up to 5 minutes, please.");
    await ctx.replyWithChatAction("typing");
    let text: string;
    try {
      const file = await ctx.getFile();
      if (!file.file_path) throw new Error("no file path");
      const res = await httpFetch(fileUrl(file.file_path));
      text = await transcribe(new Blob([await res.arrayBuffer()]), file.file_path.split("/").pop() ?? "voice.ogg");
    } catch (err) {
      console.error("[telegram] transcription failed:", err);
      return ctx.reply("Sorry, I couldn't make out that voice message. Try again or type it.");
    }
    await ctx.reply(`🎙 “${text}”`);
    await answer(ctx, text, schedule);
  });

  bot.on("message", (ctx) => ctx.reply("I can read text, voice notes and chat-export files. Try /help."));

  bot.catch((err) => console.error("[telegram] error:", err.error));
  return bot;
}

function fileUrl(path: string) {
  return `https://api.telegram.org/file/bot${env.telegram.token}/${path}`;
}

async function downloadText(ctx: Context, fileId: string): Promise<string | null> {
  try {
    const file = await ctx.api.getFile(fileId);
    if (!file.file_path) return null;
    const res = await httpFetch(fileUrl(file.file_path));
    return res.ok ? await res.text() : null;
  } catch (err) {
    console.error("[telegram] download failed:", err);
    return null;
  }
}

async function importTarget(ctx: Context, index: number): Promise<string | undefined> {
  const fileId = ctx.callbackQuery?.message?.reply_to_message?.document?.file_id;
  const raw = fileId ? await downloadText(ctx, fileId) : null;
  return raw ? senders(parseChat(raw))[index]?.name : undefined;
}

/** Telegram caps messages at 4096 chars. */
function chunks(text: string, size = 4000): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > size) {
    const cut = rest.lastIndexOf("\n", size) > size / 2 ? rest.lastIndexOf("\n", size) : size;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

async function answer(ctx: Context, text: string, schedule: Schedule) {
  const wait = rateLimit(user(ctx), "chat");
  if (wait) {
    await ctx.reply(`You're sending messages fast! Give me ${wait}s.`);
    return;
  }
  const s = await session(ctx);
  await ctx.replyWithChatAction("typing");
  try {
    const { result, afterTurn } = await respond({
      user: user(ctx),
      message: text.slice(0, 4000),
      history: s.history,
      mode: s.mode,
      persona: s.persona,
      channel: "telegram",
    });
    const reply = (await result.text).trim() || "…";
    s.history.push({ role: "user", content: text }, { role: "assistant", content: reply });
    s.history = s.history.slice(-12);
    for (const part of chunks(reply)) await ctx.reply(part);
    schedule(afterTurn);
  } catch (err) {
    console.error("[telegram] respond failed:", err);
    await ctx.reply("Something went wrong on my side. Try again in a moment.");
  }
}
