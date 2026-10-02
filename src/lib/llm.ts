import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";
import { env } from "./env";

const provider = createOpenAICompatible({
  name: "llm",
  baseURL: env.llm.baseURL,
  apiKey: env.llm.apiKey,
});

export function chatModel() {
  if (!env.llm.apiKey) {
    throw new Error("LLM_API_KEY is not set. Add it to .env.local.");
  }
  return provider(env.llm.model);
}

/** Provider options shared by every call (keyed by the provider name above). */
export const llmOptions = () => ({ llm: { reasoningEffort: env.llm.reasoningEffort } });

/**
 * Ask the model for JSON and parse it leniently. We avoid provider-specific
 * "JSON mode" so any OpenAI-compatible model works.
 */
export async function generateJson<T>(instructions: string, prompt: string): Promise<T | null> {
  const { text } = await generateText({
    model: chatModel(),
    instructions: `${instructions}\n\nRespond with a single JSON object only. No prose, no code fences.`,
    prompt,
    temperature: 0.2,
    providerOptions: llmOptions(),
  });
  return parseJsonLoose<T>(text);
}

export function parseJsonLoose<T>(text: string): T | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}
