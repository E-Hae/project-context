import assert from "node:assert/strict";
import test from "node:test";

import { traceAdapter } from "../src/index.js";

test("core resolver discovers the C# adapter through its exported contract", async () => {
  const { resolveTraceAdapter } = await import(
    new URL("../../../../dist/src/trace-adapter-resolver.js", import.meta.url).href,
  );
  const adapter = await resolveTraceAdapter(
    { language: "csharp", sourceFileExtensions: [".cs"] },
    {
      packageNames: ["project-context-mcp-csharp"],
      loadModule: async () => ({ traceAdapter }),
    },
  );
  assert.equal(adapter, traceAdapter);
});
