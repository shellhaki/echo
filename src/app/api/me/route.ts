import { usingMockMemory } from "@/lib/env";
import { userNamespaces } from "@/lib/memory";
import { getWebUser } from "@/lib/web-user";

export async function GET() {
  const user = await getWebUser();
  const spaces = await userNamespaces(user).catch(() => []);
  const count = (suffix: string) =>
    spaces.filter((n) => n.name.endsWith(suffix)).reduce((a, n) => a + n.memory_count, 0);
  return Response.json({
    user: user.startsWith("tg:") ? "Telegram-linked account" : "Anonymous web user",
    linked: user.startsWith("tg:"),
    mock: usingMockMemory(),
    memories: {
      facts: count("-facts"),
      style: count("-style"),
      personas: spaces.filter((n) => n.name.includes("-p-")).reduce((a, n) => a + n.memory_count, 0),
    },
  });
}
