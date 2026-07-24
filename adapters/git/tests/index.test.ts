import assert from "node:assert/strict";
import test from "node:test";

import { createGitImpactAdapter } from "../src/index.js";

test("Git adapter ranks files that change with the target", async () => {
  const adapter = createGitImpactAdapter(async (_root, args) => {
    if (args[0] === "log") return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\t2026-07-24T00:00:00+00:00\nbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\t2026-07-23T00:00:00+00:00\n";
    if (args.at(-1) === "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa") return "src/target.ts\nsrc/shared.ts\n";
    return "src/target.ts\nsrc/shared.ts\nsrc/other.ts\n";
  });

  const result = await adapter.analyze({ projectRoot: ".", target: "src/target.ts", maxResults: 10, historyLimit: 20 });

  assert.equal(result.commitsAnalyzed, 2);
  assert.deepEqual(result.results.map((entry) => [entry.path, entry.cochangeCount]), [
    ["src/shared.ts", 2],
    ["src/other.ts", 1],
  ]);
});
