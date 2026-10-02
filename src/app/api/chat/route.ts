import { after } from "next/server";
import { z } from "zod";
import { respond } from "@/lib/brain";
import { rateLimit } from "@/lib/rate-limit";
import { getWebUser } from "@/lib/web-user";

export const maxDuration = 60;

const Body = z.object({
  message: z.string().trim().min(1).max(4000),
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(8000) }))
    .max(40)
    .default([]),
  mode: z.enum(["assistant", "mirror", "persona"]).default("assistant"),
  persona: z.string().max(64).optional(),
  strength: z.number().min(0).max(100).default(70),
});

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid request" }, { status: 400 });

  const user = await getWebUser();
  const wait = rateLimit(user, "chat");
  if (wait) return Response.json({ error: `You're sending messages fast. Try again in ${wait}s.` }, { status: 429 });
  try {
    const { result, debug, afterTurn } = await respond({ ...parsed.data, user, channel: "web" });
    // Extract facts + learn style once the response has finished streaming.
    after(afterTurn);
    return result.toTextStreamResponse({
      headers: {
        // Debug panel data: only this user's own recalled memories.
        "x-wb-debug": Buffer.from(JSON.stringify(debug)).toString("base64"),
      },
    });
  } catch (err) {
    console.error("[chat] failed:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return Response.json({ error: message }, { status: 500 });
  }
}
