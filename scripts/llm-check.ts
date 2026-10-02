// Quick LLM connectivity check: `npm run llm:check`
import "./load-env";
import { generateText } from "ai";
import { env } from "../src/lib/env";
import { chatModel } from "../src/lib/llm";

console.log(`LLM: ${env.llm.baseURL}  model=${env.llm.model}  key=${env.llm.apiKey ? "set" : "MISSING"}`);
const { text, usage } = await generateText({ model: chatModel(), prompt: "Reply with exactly: yo! echobot online" });
console.log("reply:", text, usage);
