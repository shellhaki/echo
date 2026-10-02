import { rateLimit } from "@/lib/rate-limit";
import { transcribe } from "@/lib/voice/stt";
import { getWebUser } from "@/lib/web-user";

export const maxDuration = 30;

// Fallback speech-to-text for browsers without the Web Speech API.
export async function POST(req: Request) {
  const wait = rateLimit(await getWebUser(), "voice");
  if (wait) return Response.json({ error: `Too many recordings. Try again in ${wait}s.` }, { status: 429 });
  const form = await req.formData().catch(() => null);
  const file = form?.get("audio");
  if (!(file instanceof Blob)) return Response.json({ error: "No audio received." }, { status: 400 });
  if (file.size > 20 * 1024 * 1024) return Response.json({ error: "Recording is too long." }, { status: 413 });
  try {
    const name = file instanceof File && file.name ? file.name : "audio.webm";
    return Response.json({ text: await transcribe(file, name) });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Transcription failed." }, { status: 502 });
  }
}
