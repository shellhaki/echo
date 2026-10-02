// Count memories (= Walrus blobs) per namespace for submission evidence: `npm run blobs`

import "./load-env";
import { env, usingMockMemory } from "../src/lib/env";
import { allNamespaces } from "../src/lib/memory";

if (usingMockMemory()) console.warn("WARNING: running against the mock, counts are not real.\n");
const spaces = (await allNamespaces()).sort((a, b) => b.memory_count - a.memory_count);
const kinds = { facts: 0, style: 0, persona: 0, other: 0 };
for (const n of spaces) {
  const kind = n.name.endsWith("-facts") ? "facts" : n.name.endsWith("-style") ? "style" : n.name.includes("-p-") ? "persona" : "other";
  kinds[kind] += n.memory_count;
}
const users = new Set(spaces.map((n) => n.name.match(/-u-([a-f0-9]+)-/)?.[1]).filter(Boolean));
console.log(`Account: ${env.memwal.accountId ?? "(mock)"}`);
console.log(`Namespaces: ${spaces.length}   Users: ${users.size}`);
console.log(`Memories (blobs): ${spaces.reduce((a, n) => a + n.memory_count, 0)}`, kinds);
console.log(`Storage used: ${spaces.reduce((a, n) => a + n.storage_used, 0)} bytes`);
