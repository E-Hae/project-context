import assert from "node:assert/strict";
import test from "node:test";

import type { TraceAdapter } from "../src/trace-adapter.js";
import {
  configuredTraceAdapterNames,
  discoverTraceAdapters,
  resolveTraceAdapter,
  TraceAdapterContractError,
  TraceAdapterLanguageRequiredError,
} from "../src/trace-adapter-resolver.js";

function fixtureAdapter(name: string, language: string, extension: string): TraceAdapter {
  return {
    name,
    language,
    sourceFileExtensions: [extension],
    async probe() { return { available: true, detail: "fixture is available" }; },
    async trace() {
      throw new Error("not used by resolver tests");
    },
  };
}

test("trace adapter candidates retain the default and honor PROJECT_CONTEXT_TRACE_ADAPTERS values", () => {
  assert.deepEqual(configuredTraceAdapterNames(""), ["project-context-mcp-csharp"]);
  assert.deepEqual(
    configuredTraceAdapterNames("fixture-python, project-context-mcp-csharp, invalid package"),
    ["project-context-mcp-csharp", "fixture-python"],
  );
});

test("resolver selects exactly one adapter from project source extensions", async () => {
  const csharp = fixtureAdapter("fixture-csharp", "csharp", ".cs");
  const python = fixtureAdapter("fixture-python", "python", ".py");
  const selected = await resolveTraceAdapter(
    { sourceFileExtensions: [".py"] },
    {
      packageNames: ["fixture-csharp", "fixture-python"],
      loadModule: async (packageName) => ({
        traceAdapter: packageName === "fixture-csharp" ? csharp : python,
      }),
    },
  );
  assert.equal(selected, python);

  await assert.rejects(
    resolveTraceAdapter(
      { sourceFileExtensions: [".cs", ".py"] },
      {
        packageNames: ["fixture-csharp", "fixture-python"],
        loadModule: async (packageName) => ({
          traceAdapter: packageName === "fixture-csharp" ? csharp : python,
        }),
      },
    ),
    (error: unknown) => error instanceof TraceAdapterLanguageRequiredError,
  );
});

test("resolver reports an invalid adapter contract instead of treating it as missing", async () => {
  const discovery = await discoverTraceAdapters({
    packageNames: ["broken-adapter"],
    loadModule: async () => ({ traceAdapter: { name: "broken" } }),
  });
  assert.deepEqual(discovery.adapters, []);
  assert.match(discovery.diagnostics[0]?.detail ?? "", /valid traceAdapter contract/);

  await assert.rejects(
    resolveTraceAdapter({}, {
      packageNames: ["broken-adapter"],
      loadModule: async () => ({ traceAdapter: { name: "broken" } }),
    }),
    (error: unknown) => error instanceof TraceAdapterContractError,
  );
});
