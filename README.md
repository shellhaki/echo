# EchoBot

> The AI that remembers you — then starts sounding like you.

An AI assistant that **remembers you across sessions and channels**, and **learns to talk like you**. Its memory is stored on [Walrus Memory](https://memory.walrus.xyz).

Built for Walrus Sessions: *Chatbots That Remember*.

- **Web app**: chat, voice input with a live transcript, spoken replies, and a memory debug panel.
- **Telegram bot**: text and voice notes.
- **CLI**: `npm run cli`.
- **Shared memory**: all three channels use one brain (`src/lib/brain.ts`), so memory works the same everywhere. Send `/link` to the bot to share one memory across web, Telegram and CLI.

## What makes it different

| Mode | What it does |
|---|---|
| **Assistant** | Remembers durable facts about you (name, projects, preferences, goals) and recalls them in any new session. |
| **Mirror me** | Learns *how* you talk: greetings, slang, catchphrases, emoji, casing, message length. It then replies in your voice. Say "yo!" a few times and it starts saying "yo!" back. |
| **Persona** | Import a WhatsApp or Telegram chat export (with the person's consent) and chat with an AI that texts like them. |

## How memory works

```
message ─┬─► recall facts  (namespace …-facts)   ┐
         └─► recall style  (…-style or …-p-<id>) ┴─► prompt ─► LLM ─► reply
                                                                  │
after reply (background): memwal.analyze() extracts durable facts ◄┘
                          style scan stores new traits + voice samples
```

- **SDK**: the official `@mysten-incubation/memwal` SDK against the production relayer, `https://relayer.memory.walrus.xyz`.
- **What gets stored**: not every message. `analyze()` keeps only durable facts. The style scanner keeps only new traits and distinctive messages.
- **Isolation**: every user gets their own namespaces, `wb-{env}-u-{hash}-facts|style|p-<persona>`. The hash is `sha256(salt + channel:id)`, so raw Telegram or cookie IDs never appear in a namespace. `{env}` keeps dev and prod data apart.
- **Debug panel scope**: the web memory panel shows only the current user's own recalled memories.
- **Key safety**: the MemWal delegate key is used server-side only.

**LLM:** Meta **Muse Spark** (`muse-spark-1.3-contributor`, reasoning effort `minimal`) through the Meta Model API, using `@ai-sdk/openai-compatible`. Any OpenAI-compatible model works; change the `LLM_*` variables.
**Speech-to-text:** browser Web Speech API. The fallback, and Telegram voice notes, use an OpenAI-compatible Whisper endpoint (Groq by default).
**Text-to-speech:** browser `speechSynthesis`.

## Setup

```bash
npm install
cp .env.example .env.local   # fill in the values
npm run smoke                # writes + recalls one memory on Walrus Mainnet
npm run dev                  # http://localhost:3000
```

Leave the `MEMWAL_*` variables empty to run on the SDK's in-memory mock. Nothing is then written to Walrus.

### Getting Walrus Memory credentials
1. Create a **new, dedicated** Sui wallet (for example Slush) for this project.
2. Open https://memory.walrus.xyz, connect the wallet and create a Walrus Memory account.
3. Generate a delegate key. Copy the **account ID** into `MEMWAL_ACCOUNT_ID`. It is the account object ID, not your wallet address and not the public key. Copy the **delegate private key** into `MEMWAL_PRIVATE_KEY`.

### Telegram
```bash
npm run telegram                                    # local, long polling
npm run telegram:webhook -- https://<your-app>.vercel.app   # production webhook
```

Bot commands: `/help`, `/mirror`, `/assistant`, `/new`, `/memories`, `/personas`, `/talkto <name>`, `/link`.
To build a persona on Telegram, send the bot a WhatsApp export (`.txt`) or a Telegram export (`result.json`), pick the person, and confirm they consented.
The bot only answers in private chats.

## Deploy (Vercel)

1. Push to GitHub and import the repo in Vercel (framework: Next.js, Node 22.19 or later).
2. Add every variable from `.env.example` in Vercel → Settings → Environment Variables. Set `MEMWAL_ENV=prod` and a long random `USER_ID_SALT`. Never change the salt afterwards: changing it disconnects existing users from their memories.
3. Deploy, then point Telegram at the deployment:
   ```bash
   npm run telegram:webhook -- https://<your-app>.vercel.app
   ```
4. Check `/api/me` in the browser. It should report `"mock": false`.

## Limits and safeguards
- The Walrus Memory relayer allows about 60 requests per minute per delegate key. EchoBot keeps each chat turn to 1–3 relayer calls:
  - it caches style profiles for 60 s;
  - it skips fact extraction for messages that can't contain facts ("lol", "ok");
  - it batches writes;
  - it retries background writes when rate-limited.
- New memories take a few seconds (single facts) up to a couple of minutes (persona imports) to be indexed. Recent writes are served from a short-lived cache so they're usable immediately.
- Per-user rate limits: 20 messages/min, 10 voice notes/min, 3 persona imports/hour.
- Persona imports require an explicit consent confirmation, and personas always identify as AI when asked.

### CLI
```bash
npm run cli
```

## Demo script
1. **Session 1**: "My name is Alex. I'm building a startup called PayFlow. I'm using TypeScript and Next.js."
2. Click **New session**, or run `/new` in the CLI, or restart the CLI.
3. Ask "What is my startup called?" and "What programming language do I prefer?". It answers **PayFlow** and **TypeScript**. The memory panel shows the memories it recalled from Walrus.
4. **Mirror me**: chat casually with your own slang for a few messages, start a new session, and the assistant talks back in your style.

## Submission evidence
```bash
npm run blobs   # memories (= Walrus blobs) per namespace, users, storage used
```

## Project layout
```
src/lib/brain.ts        respond(): recall → prompt → stream → learn (shared by all channels)
src/lib/memory.ts       MemWal client, namespaces, isolation
src/lib/style.ts        style learning + mirror/persona prompts
src/lib/persona.ts      WhatsApp / Telegram export parsing, persona import
src/lib/telegram.ts     grammY bot (text + voice)
src/lib/voice/stt.ts    speech-to-text provider
src/lib/identity.ts     signed cookies + Telegram link codes
src/app/                web UI + API routes
scripts/                cli, telegram, smoke test, blob count
```
