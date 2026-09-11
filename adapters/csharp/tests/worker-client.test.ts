import assert from "node:assert/strict";
import test from "node:test";

import { getRoslynWorkerPath } from "../src/worker-client.js";
import { createCsharpTraceAdapter } from "../src/index.js";

test("C# adapter resolves its worker inside the adapter package", () => {
  assert.match(
    getRoslynWorkerPath("C:/adapter"),
    /adapter[\\/]workers[\\/]roslyn[\\/]bin[\\/]Release[\\/]net8\.0[\\/]ProjectContext\.Roslyn\.dll$/,
  );
});

test("C# adapter treats a worker that rejects a direction as unavailable", async () => {
  const adapter = createCsharpTraceAdapter(
    async () => ({
      version: 1,
      ok: false,
      error: { code: "invalid_direction", message: "Trace direction is invalid", candidates: [] },
    }),
    async () => "project-context-roslyn/0.3.0",
  );
  await assert.rejects(
    adapter.trace({
      projectRoot: "C:/project",
      files: ["src/Feature.cs"],
      auxiliaryFiles: [],
      symbol: "Feature",
      direction: "derived",
      maxResults: 10,
    }),
    (error: unknown) => (error as { code?: unknown }).code === "unavailable",
  );
});

test("C# adapter probe reports a missing dotnet runtime accurately", async () => {
  const adapter = createCsharpTraceAdapter(
    async () => ({ version: 1, ok: false, error: { code: "failed", message: "unused", candidates: [] } }),
    async () => { throw new Error("dotnet is unavailable"); },
  );
  assert.deepEqual(await adapter.probe(), {
    available: false,
    detail: "dotnet is unavailable",
  });
});
