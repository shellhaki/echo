import { env, usingMockMemory } from "@/lib/env";
import { httpFetch } from "@/lib/http";
import { userNamespaces } from "@/lib/memory";
import { getWebUser } from "@/lib/web-user";

let botUsername: Promise<string | null> | undefined;

/** Bot @username for the "Chat on Telegram" link, looked up once per instance. */
function getBotUsername() {
  if (!env.telegram.token) return Promise.resolve(null);
  botUsername ??= httpFetch(`https://api.telegram.org/bot${env.telegram.token}/getMe`)
    .then((r) => r.json() as Promise<{ result?: { username?: string } }>)
    .then((d) => d.result?.username ?? null)
    .catch(() => {
      botUsername = undefined;
      return null;
    });
  return botUsername;
}

export async function GET() {
  const user = await getWebUser();
  const [spaces, bot] = await Promise.all([userNamespaces(user).catch(() => []), getBotUsername()]);
  const count = (pred: (name: string) => boolean) =>
    spaces.filter((n) => pred(n.name)).reduce((a, n) => a + n.memory_count, 0);
  return Response.json({
    user: user.startsWith("tg:") ? "Telegram-linked account" : "Anonymous web user",
    linked: user.startsWith("tg:"),
    mock: usingMockMemory(),
    bot,
    memories: {
      facts: count((n) => n.endsWith("-facts")),
      style: count((n) => n.endsWith("-style")),
      personas: count((n) => n.includes("-p-")),
    },
  });
}
