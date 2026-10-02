// Point Telegram at the deployed webhook: `npm run telegram:webhook -- https://your-app.vercel.app`

import "./load-env";
import { Bot } from "grammy";
import { env } from "../src/lib/env";

const base = process.argv[2];
if (!base || !env.telegram.token) {
  console.error("Usage: npm run telegram:webhook -- https://your-app.vercel.app (and set TELEGRAM_BOT_TOKEN)");
  process.exit(1);
}
const bot = new Bot(env.telegram.token);
const url = `${base.replace(/\/$/, "")}/api/telegram`;
await bot.api.setWebhook(url, { secret_token: env.telegram.webhookSecret });
await bot.api.setMyCommands([
  { command: "start", description: "What I can do" },
  { command: "mirror", description: "Talk like me" },
  { command: "assistant", description: "Normal assistant mode" },
  { command: "personas", description: "List imported personas" },
  { command: "talkto", description: "Chat with a persona" },
  { command: "memories", description: "What you've stored" },
  { command: "link", description: "Share memory with web + CLI" },
]);
console.log("Webhook set:", url);
console.log(await bot.api.getWebhookInfo());
