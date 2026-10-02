import { webhookCallback } from "grammy";
import { after } from "next/server";
import { env } from "@/lib/env";
import { createBot } from "@/lib/telegram";

export const maxDuration = 60;

let handler: ((req: Request) => Promise<Response>) | undefined;

export async function POST(req: Request) {
  if (!env.telegram.token) return new Response("Telegram not configured", { status: 503 });
  handler ??= webhookCallback(
    createBot((task) => after(task)),
    "std/http",
    { secretToken: env.telegram.webhookSecret, timeoutMilliseconds: 55_000, onTimeout: "return" },
  );
  return handler(req);
}
