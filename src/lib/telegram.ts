// Telegram bot. The same bot runs two ways:
//   - webhook in production (src/app/api/telegram/route.ts)
//   - long polling locally (npm run telegram)

import { Bot, type Context } from "grammy";
import { respond, personaName, type ChatTurn, type Mode } from "./brain";
import { env } from "./env";
import { makeLinkCode } from "./identity";
import { userKey, userNamespaces } from "./memory";
import { listPersonas } from "./persona";
import { transcribe } from "./voice/stt";

type Session = { mode: Mode; persona?: string; history: ChatTurn[] };

// Per-process session state (mode + short-term history). Long-term memory
// lives in Walrus, so losing this on a cold start only resets the mode.
const g = globalThis as unknown as { __wbTgSessions?: Map<number, Session> };
const sessions = (g.__wbTgSessions ??= new Map());

function session(id: number): Session {
  let s = sessions.get(id);
  if (!s) sessions.set(id, (s = { mode: "assistant", history: [] }));
  return s;
}

export function createBot(schedule: (task: () => Promise<unknown>) => void) {
  if (!env.telegram.token) throw new Error("TELEGRAM_BOT_TOKEN is not set.");
  const bot = new Bot(env.telegram.token);

  bot.command("start", (ctx) =>
    ctx.reply(
      [
        "Hey! I'm EchoBot — an assistant with memory stored on Walrus.",
        "Tell me about yourself and I'll remember it next time, even in a new chat.",
        "",
        "/mirror — I start talking like you",
        "/assistant — normal mode",
        "/personas — list personas you imported on the web app",
        "/talkto <name> — chat with a persona",
        "/memories — what I've stored for you",
        "/link — use the same memory on the web app and CLI",
        "",
        "Voice notes work too 🎙",
      ].join("\n"),
    ),
  );

  bot.command("mirror", (ctx) => {
    const s = session(ctx.from!.id);
    s.mode = "mirror";
    s.persona = undefined;
    return ctx.reply("Mirror mode on. The more you chat, the more I sound like you.");
  });

  bot.command(["assistant", "stop"], (ctx) => {
    const s = session(ctx.from!.id);
    s.mode = "assistant";
    s.persona = undefined;
    return ctx.reply("Back to normal assistant mode.");
  });

  bot.command("personas", async (ctx) => {
    const list = await listPersonas(userKey("tg", ctx.from!.id));
    if (!list.length) {
      return ctx.reply("No personas yet. Import a chat export in the web app (use /link first so it lands on this account).");
    }
    return ctx.reply(
      list.map((p) => `• ${personaName(p.slug)} — /talkto ${p.slug}`).join("\n"),
    );
  });

  bot.command("talkto", async (ctx) => {
    const slug = ctx.match.trim();
    const list = await listPersonas(userKey("tg", ctx.from!.id));
    const hit = list.find((p) => p.slug === slug || personaName(p.slug).toLowerCase() === slug.toLowerCase());
    if (!hit) return ctx.reply("Persona not found. Try /personas.");
    const s = session(ctx.from!.id);
    s.mode = "persona";
    s.persona = hit.slug;
    s.history = [];
    return ctx.reply(`Now chatting as ${personaName(hit.slug)} (AI persona). /stop to exit.`);
  });

  bot.command("link", (ctx) =>
    ctx.reply(
      `Paste this code in the web app or CLI within 15 minutes to share one memory across all of them:\n\n${makeLinkCode(ctx.from!.id)}\n\nDon't share it with anyone else.`,
    ),
  );

  bot.command("memories", async (ctx) => {
    const spaces = await userNamespaces(userKey("tg", ctx.from!.id));
    if (!spaces.length) return ctx.reply("Nothing stored yet. Tell me about yourself!");
    return ctx.reply(
      spaces.map((n) => `• ${n.name.split("-").slice(-1)[0]}: ${n.memory_count} memories`).join("\n"),
    );
  });

  bot.on("message:text", async (ctx) => {
    if (ctx.message.text.startsWith("/")) return;
    await answer(ctx, ctx.message.text, schedule);
  });

  bot.on(["message:voice", "message:audio"], async (ctx) => {
    const file = await ctx.getFile();
    if (!file.file_path) return ctx.reply("Couldn't download that voice message.");
    let text: string;
    try {
      const res = await fetch(`https://api.telegram.org/file/bot${env.telegram.token}/${file.file_path}`);
      const blob = await res.blob();
      text = await transcribe(blob, file.file_path.split("/").pop() ?? "voice.ogg");
    } catch (err) {
      console.error("[telegram] transcription failed:", err);
      return ctx.reply("Sorry, I couldn't understand that voice message. Try again or type it.");
    }
    await ctx.reply(`🎙 “${text}”`);
    await answer(ctx, text, schedule);
  });

  bot.catch((err) => console.error("[telegram] error:", err.error));
  return bot;
}

async function answer(ctx: Context, text: string, schedule: (task: () => Promise<unknown>) => void) {
  const s = session(ctx.from!.id);
  await ctx.replyWithChatAction("typing");
  try {
    const { result, afterTurn } = await respond({
      user: userKey("tg", ctx.from!.id),
      message: text,
      history: s.history,
      mode: s.mode,
      persona: s.persona,
      channel: "telegram",
    });
    const reply = (await result.text).trim() || "…";
    s.history.push({ role: "user", content: text }, { role: "assistant", content: reply });
    s.history = s.history.slice(-12);
    await ctx.reply(reply);
    schedule(afterTurn);
  } catch (err) {
    console.error("[telegram] respond failed:", err);
    await ctx.reply("Something went wrong on my side. Try again in a moment.");
  }
}
