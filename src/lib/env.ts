// Central place for configuration. Everything reads env through here so the
// web app, Telegram bot and CLI all behave the same.

function opt(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}

export const env = {
  memwal: {
    key: opt("MEMWAL_PRIVATE_KEY"),
    accountId: opt("MEMWAL_ACCOUNT_ID"),
    serverUrl: opt("MEMWAL_SERVER_URL") ?? "https://relayer.memory.walrus.xyz",
    forceMock: opt("MEMWAL_MOCK") === "1",
  },
  appEnv: opt("MEMWAL_ENV") === "prod" ? "prod" : "dev",
  userIdSalt: opt("USER_ID_SALT") ?? "walbuddy-dev-salt",
  llm: {
    baseURL: opt("LLM_BASE_URL") ?? "https://api.meta.ai/v1",
    apiKey: opt("LLM_API_KEY"),
    model: opt("LLM_MODEL") ?? "muse-spark-1.1",
    // Reasoning models think before answering; "minimal" keeps chat snappy.
    reasoningEffort: opt("LLM_REASONING_EFFORT") ?? "minimal",
  },
  stt: {
    baseURL: opt("STT_BASE_URL") ?? "https://api.groq.com/openai/v1",
    apiKey: opt("STT_API_KEY"),
    model: opt("STT_MODEL") ?? "whisper-large-v3-turbo",
  },
  telegram: {
    token: opt("TELEGRAM_BOT_TOKEN"),
    webhookSecret: opt("TELEGRAM_WEBHOOK_SECRET"),
  },
};

export function usingMockMemory(): boolean {
  return env.memwal.forceMock || !env.memwal.key || !env.memwal.accountId;
}
