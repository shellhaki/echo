// End-to-end check against the real relayer: `npm run smoke`
// Writes ONE memory to Walrus, waits for it, then recalls it.

import "./load-env";
import { env, usingMockMemory } from "../src/lib/env";
import { memwal } from "../src/lib/memory";

const client = memwal();
console.log(`Relayer: ${env.memwal.serverUrl}  mock=${usingMockMemory()}`);
console.log("health:", await client.health());

const namespace = `wb-${env.appEnv}-smoke`;
const text = `Smoke test at ${new Date().toISOString()}: EchoBot can write to Walrus.`;
console.log("remembering…");
const saved = await client.rememberAndWait(text, namespace, { timeoutMs: 120_000 });
console.log("stored blob:", saved.blob_id);

const hits = await client.recall({ query: "Can EchoBot write to Walrus?", namespace, topK: 3 });
console.log("recalled:", hits.results.map((r) => `${r.distance.toFixed(3)}  ${r.text}`));
