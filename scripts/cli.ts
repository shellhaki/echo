// EchoBot CLI: `npm run cli`
// Same brain and memory as the web app and Telegram bot.

import "./load-env";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { randomUUID } from "node:crypto";
import { stdin, stdout } from "node:process";
import { respond, personaName, type ChatTurn, type Mode } from "../src/lib/brain";
import { usingMockMemory } from "../src/lib/env";
import { redeemLinkCode } from "../src/lib/identity";
import { userKey, userNamespaces } from "../src/lib/memory";
import { listPersonas } from "../src/lib/persona";

const STATE_FILE = ".walbuddy-cli.json";
type State = { user: string };

function loadState(): State {
  if (existsSync(STATE_FILE)) return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  const state = { user: userKey("cli", randomUUID()) };
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  return state;
}

const HELP = `Commands:
  /new              start a fresh session (memory stays on Walrus)
  /mode assistant   normal assistant
  /mode mirror      talk like me
  /personas         list imported personas
  /talkto <slug>    chat with a persona
  /link <code>      use your Telegram memory (send /link to the bot)
  /memories         memory counts
  /exit             quit`;

async function main() {
  const state = loadState();
  let mode: Mode = "assistant";
  let persona: string | undefined;
  let history: ChatTurn[] = [];
  const pending: Promise<unknown>[] = [];

  console.log(`\nEchoBot CLI — memory ${usingMockMemory() ? "MOCK (in-memory, lost on exit)" : "on Walrus Mainnet"}`);
  console.log(`Type /help for commands.\n`);

  const rl = createInterface({ input: stdin, output: stdout });
  for (;;) {
    const line = (await rl.question("you › ")).trim();
    if (!line) continue;

    if (line.startsWith("/")) {
      const [cmd, ...rest] = line.split(/\s+/);
      const arg = rest.join(" ");
      if (cmd === "/exit" || cmd === "/quit") break;
      else if (cmd === "/help") console.log(HELP);
      else if (cmd === "/new") {
        history = [];
        console.log("New session. Short-term history cleared; long-term memory is still on Walrus.");
      } else if (cmd === "/mode" && (arg === "assistant" || arg === "mirror")) {
        mode = arg;
        persona = undefined;
        console.log(`Mode: ${mode}`);
      } else if (cmd === "/personas") {
        const list = await listPersonas(state.user);
        console.log(list.length ? list.map((p) => `  ${p.slug}  (${personaName(p.slug)}, ${p.memories} memories)`).join("\n") : "No personas yet.");
      } else if (cmd === "/talkto") {
        const list = await listPersonas(state.user);
        const hit = list.find((p) => p.slug === arg || personaName(p.slug).toLowerCase() === arg.toLowerCase());
        if (!hit) console.log("Persona not found. Try /personas.");
        else {
          mode = "persona";
          persona = hit.slug;
          history = [];
          console.log(`Now chatting with ${personaName(hit.slug)} (AI persona). /mode assistant to exit.`);
        }
      } else if (cmd === "/link") {
        const user = redeemLinkCode(arg);
        if (!user) console.log("Invalid or expired code.");
        else {
          state.user = user;
          writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
          history = [];
          console.log("Linked to your Telegram memory.");
        }
      } else if (cmd === "/memories") {
        const spaces = await userNamespaces(state.user);
        console.log(spaces.length ? spaces.map((n) => `  ${n.name.split("-").pop()}: ${n.memory_count}`).join("\n") : "Nothing stored yet.");
      } else console.log(HELP);
      continue;
    }

    try {
      const { result, debug, afterTurn } = await respond({
        user: state.user,
        message: line,
        history,
        mode,
        persona,
        channel: "cli",
      });
      if (debug.facts.length) console.log(`\x1b[2m  [recalled ${debug.facts.length} memories from Walrus]\x1b[0m`);
      stdout.write(mode === "persona" && persona ? `${personaName(persona).toLowerCase()} › ` : "echobot › ");
      let reply = "";
      for await (const chunk of result.textStream) {
        reply += chunk;
        stdout.write(chunk);
      }
      stdout.write("\n\n");
      history.push({ role: "user", content: line }, { role: "assistant", content: reply });
      history = history.slice(-12);
      pending.push(afterTurn().catch(() => {}));
    } catch (err) {
      console.error(`error: ${err instanceof Error ? err.message : err}\n`);
    }
  }

  rl.close();
  if (pending.length) {
    stdout.write("Saving memories to Walrus… ");
    await Promise.all(pending);
    console.log("done.");
  }
  process.exit(0);
}

main();
