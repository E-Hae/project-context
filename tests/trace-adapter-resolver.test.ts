import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { TraceAdapter } from "../src/trace-adapter.js";
import {
  configuredTraceAdapterNames,
  discoverTraceAdapters,
  resolvePackageFromNodeModulesRoot,
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

function aliasedFixtureAdapter(): TraceAdapter {
  return {
    name: "fixture-typescript",
    language: "typescript",
    languageAliases: ["javascript", "js"],
    sourceFileExtensions: [".ts", ".js"],
    async probe() { return { available: true, detail: "fixture is available" }; },
    async trace() {
      throw new Error("not used by resolver tests");
    },
  };
}

test("trace adapter candidates retain the default and honor PROJECT_CONTEXT_TRACE_ADAPTERS values", () => {
  assert.deepEqual(configuredTraceAdapterNames(""), [
    "project-context-mcp-csharp",
    "project-context-mcp-typescript",
  ]);
  assert.deepEqual(
    configuredTraceAdapterNames("fixture-python, project-context-mcp-csharp, invalid package"),
    ["project-context-mcp-csharp", "project-context-mcp-typescript", "fixture-python"],
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

test("resolver accepts trace adapter language aliases", async () => {
  const adapter = aliasedFixtureAdapter();
  const selected = await resolveTraceAdapter(
    { language: "javascript", sourceFileExtensions: [".js"] },
    {
      packageNames: ["fixture-typescript"],
      loadModule: async () => ({ traceAdapter: adapter }),
    },
  );
  assert.equal(selected, adapter);
});

test("resolver can resolve a package from an npm-style global node_modules root", async () => {
  const prefix = await mkdtemp(path.join(tmpdir(), "project-context-global-modules-"));
  const nodeModulesRoot = path.join(prefix, "node_modules");
  const packageRoot = path.join(nodeModulesRoot, "fixture-global-adapter");
  try {
    await mkdir(packageRoot, { recursive: true });
    await writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "fixture-global-adapter", type: "module", exports: "./index.js" }),
      "utf8",
    );
    await writeFile(path.join(packageRoot, "index.js"), "export const traceAdapter = {};\n", "utf8");

    assert.equal(
      resolvePackageFromNodeModulesRoot("fixture-global-adapter", nodeModulesRoot),
      path.join(packageRoot, "index.js"),
    );
  } finally {
    await rm(prefix, { recursive: true, force: true });
  }
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
