import { z } from "zod";
import { personaName } from "@/lib/brain";
import { importPersona, listPersonas, parseChat, senders } from "@/lib/persona";
import { rateLimit } from "@/lib/rate-limit";
import { getWebUser } from "@/lib/web-user";

export const maxDuration = 60;

export async function GET() {
  const user = await getWebUser();
  const list = await listPersonas(user).catch(() => []);
  return Response.json({ personas: list.map((p) => ({ ...p, name: personaName(p.slug) })) });
}

const Body = z.object({
  raw: z.string().min(20).max(4_000_000),
  // Omit to just get the list of senders found in the export.
  target: z.string().max(80).optional(),
  consent: z.boolean().optional(),
  maxExamples: z.number().int().min(5).max(60).optional(),
});

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Upload a chat export first." }, { status: 400 });
  const { raw, target, consent, maxExamples } = parsed.data;

  if (!target) {
    const found = senders(parseChat(raw));
    if (!found.length) return Response.json({ error: "Couldn't find any messages in that file." }, { status: 422 });
    return Response.json({ senders: found.slice(0, 20) });
  }
  if (!consent) {
    return Response.json({ error: "Confirm that this person agreed to be turned into a persona." }, { status: 400 });
  }
  const user = await getWebUser();
  const wait = rateLimit(user, "import");
  if (wait) return Response.json({ error: `Too many imports. Try again in ${Math.ceil(wait / 60)} min.` }, { status: 429 });
  try {
    const res = await importPersona({ user, raw, target, maxExamples });
    return Response.json({ ...res, name: personaName(res.slug) });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Import failed." }, { status: 500 });
  }
}
