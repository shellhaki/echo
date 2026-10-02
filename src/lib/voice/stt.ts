// Speech-to-text behind one function so the provider can be swapped by env.
// Works with any OpenAI-compatible /audio/transcriptions endpoint
// (Groq, OpenAI, Meta, local whisper servers...).

import { FormData } from "undici";
import { env } from "../env";
import { httpFetch } from "../http";

export async function transcribe(audio: Blob, filename = "audio.webm"): Promise<string> {
  if (!env.stt.apiKey) throw new Error("STT_API_KEY is not set.");
  if (audio.size < 1000) throw new Error("Audio is empty or too short.");

  const form = new FormData();
  form.append("file", new Blob([await audio.arrayBuffer()], { type: audio.type }), filename);
  form.append("model", env.stt.model);
  form.append("response_format", "json");

  let res: Awaited<ReturnType<typeof httpFetch>>;
  try {
    res = await httpFetch(`${env.stt.baseURL.replace(/\/$/, "")}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.stt.apiKey}` },
      body: form,
    });
  } catch (err) {
    console.error("[stt] request failed:", err, (err as { cause?: unknown }).cause);
    throw new Error("Couldn't reach the speech-to-text service.");
  }
  if (!res.ok) {
    throw new Error(`Transcription failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
  const data = (await res.json()) as { text?: string };
  const text = data.text?.trim() ?? "";
  if (!text) throw new Error("Couldn't hear any speech in that recording.");
  return text;
}
