import { z } from "zod";
import { redeemLinkCode } from "@/lib/identity";
import { setWebUser } from "@/lib/web-user";

export async function POST(req: Request) {
  const body = z.object({ code: z.string().max(100) }).safeParse(await req.json().catch(() => null));
  const user = body.success ? redeemLinkCode(body.data.code) : null;
  if (!user) return Response.json({ error: "Invalid or expired code. Send /link to the bot again." }, { status: 400 });
  await setWebUser(user);
  return Response.json({ ok: true });
}
