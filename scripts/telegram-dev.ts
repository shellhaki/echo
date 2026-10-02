// Run the Telegram bot locally with long polling: `npm run telegram`
// (In production the bot runs as a webhook at /api/telegram instead.)

import "./load-env";
import { createBot } from "../src/lib/telegram";

const bot = createBot((task) => void task().catch((e) => console.error("[telegram] background task:", e)));
await bot.api.deleteWebhook();
console.log("EchoBot Telegram bot running (long polling). Ctrl+C to stop.");
await bot.start();
