import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  GraphTraceError,
  traceProject,
  type GraphSymbolNode,
} from "../src/graph-client.js";
import type {
  TraceAdapter,
  TraceAdapterRequest,
  TraceAdapterResponse,
} from "../src/trace-adapter.js";
import { TraceAdapterUnavailableError } from "../src/trace-adapter-resolver.js";
import { writeProjectConfig } from "./project-config-fixture.js";

const diagnostics = {
  filesRequested: 2, filesLoaded: 2, filesSkipped: 0,
  partial: false, elapsedMs: 10, messages: [],
};

function node(
  name: string, fullName: string, sourcePath: string, line: number, fileHash: string,
): GraphSymbolNode {
  return {
    name, fullName, signature: `${fullName}()`, kind: "method",
    path: sourcePath, lineStart: line, lineEnd: line, fileHash,
    metadata: { fixtureAssembly: "Fixture" },
  };
}

function adapter(
  trace: (request: TraceAdapterRequest) => Promise<TraceAdapterResponse>,
): TraceAdapter {
  return {
    name: "fixture", language: "csharp", sourceFileExtensions: [".cs"],
    auxiliaryFileExtensions: [".asmdef"],
    probe: async () => ({ available: true, detail: "fixture is available" }),
    trace,
  };
}

test("traceProject bounds adapter input and re-reads source evidence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-context-graph-"));
  try {
    await mkdir(path.join(root, "src"));
    await writeProjectConfig(root, [
      "version: 1", "sources:", "  code: [src]", "  documents: []",
      "  semanticExclude: [src/Caller.cs]",
      "exclude: [src/Excluded.cs]", "",
    ].join("\n"));
    const featurePath = path.join(root, "src", "Feature.cs");
    const callerPath = path.join(root, "src", "Caller.cs");
    await writeFile(featurePath, "class Feature { public void Target() {} }\n", "utf8");
    await writeFile(callerPath, "class Caller {\n  void Invoke() { new Feature().Target(); }\n}\n", "utf8");
    await writeFile(path.join(root, "src", "Excluded.cs"), "class Excluded {}\n", "utf8");
    await writeFile(path.join(root, "src", "Fixture.asmdef"), "{\"name\":\"Fixture\"}\n", "utf8");
    const fileHash = createHash("sha256").update(await readFile(callerPath)).digest("hex");
    const featureHash = createHash("sha256").update(await readFile(featurePath)).digest("hex");
    const captured: { request?: TraceAdapterRequest } = {};

    const result = await traceProject(
      { projectPath: root, symbol: "Feature.Target", direction: "callers" },
      {
        now: () => new Date("2026-07-14T00:00:00.000Z"),
        adapter: adapter(async (request) => {
          captured.request = request;
          return {
            workerVersion: "fixture-adapter/1.0", symbol: request.symbol,
            direction: request.direction,
            matchedSymbols: [node("Target", "Feature.Target", "src/Feature.cs", 1, featureHash)],
            results: [{
              relation: "calls",
              from: node("Invoke", "Caller.Invoke", "src/Caller.cs", 2, fileHash),
              to: node("Target", "Feature.Target", "src/Feature.cs", 1, featureHash),
              evidence: { path: "src/Caller.cs", lineStart: 2, lineEnd: 2, text: "untrusted", fileHash },
            }],
            truncated: false, diagnostics,
          };
        }),
      },
    );
    assert.deepEqual(captured.request?.files, ["src/Caller.cs", "src/Feature.cs"]);
    assert.deepEqual(captured.request?.auxiliaryFiles, ["src/Fixture.asmdef"]);
    assert.equal(result.results[0]?.evidence.text, "void Invoke() { new Feature().Target(); }");
    assert.equal(result.analyzedAt, "2026-07-14T00:00:00.000Z");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("traceProject rejects stale and escaping adapter evidence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-context-graph-"));
  try {
    await mkdir(path.join(root, "src"));
    await writeProjectConfig(root, "version: 1\nsources:\n  code: [src]\n  documents: []\n");
    const sourcePath = path.join(root, "src", "Feature.cs");
    await writeFile(sourcePath, "class Feature { void Target() {} }\n", "utf8");
    const originalHash = createHash("sha256").update(await readFile(sourcePath)).digest("hex");
    const feature = node("Target", "Feature.Target", "src/Feature.cs", 1, originalHash);
    const stale = await traceProject(
      { projectPath: root, symbol: "Feature.Target", direction: "callers" },
      { adapter: adapter(async (request) => {
        await writeFile(sourcePath, "class Feature { void Target() { } }\n", "utf8");
        return {
          workerVersion: "fixture", symbol: request.symbol, direction: request.direction,
          matchedSymbols: [feature], results: [{ relation: "calls", from: feature, to: feature,
            evidence: { path: "src/Feature.cs", lineStart: 1, lineEnd: 1, text: "", fileHash: originalHash } }],
          truncated: false, diagnostics: { ...diagnostics, filesRequested: 1, filesLoaded: 1 },
        };
      }) },
    );
    assert.equal(stale.stale, true);
    await assert.rejects(
      traceProject(
        { projectPath: root, symbol: "Feature.Target", direction: "callers" },
        { adapter: adapter(async (request) => ({
          workerVersion: "fixture", symbol: request.symbol, direction: request.direction,
          matchedSymbols: [{ ...feature, path: "../secret.cs" }], results: [], truncated: false,
          diagnostics: { ...diagnostics, filesRequested: 1, filesLoaded: 1 },
        })) },
      ),
      (error: unknown) => error instanceof GraphTraceError && error.code === "adapter_protocol",
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("traceProject reports a clear unavailable-adapter error", async () => {
  await assert.rejects(
    traceProject(
      { projectPath: ".", symbol: "Feature.Target", direction: "callers" },
      {
        resolveAdapter: async () => {
          throw new TraceAdapterUnavailableError(null, ["project-context-mcp-csharp"]);
        },
      },
    ),
    (error: unknown) =>
      error instanceof GraphTraceError &&
      error.code === "adapter_unavailable" &&
      /Install a language adapter/.test(error.message),
  );
});

test("traceProject passes candidate source extensions to language-neutral adapter selection", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-context-graph-"));
  try {
    await mkdir(path.join(root, "src"));
    await writeProjectConfig(root, "version: 1\nsources:\n  code: [src]\n  documents: []\n");
    await writeFile(path.join(root, "src", "Feature.cs"), "class Feature {}\n", "utf8");
    await writeFile(path.join(root, "src", "helper.py"), "def helper(): pass\n", "utf8");
    let sourceFileExtensions: readonly string[] | undefined;
    await traceProject(
      { projectPath: root, symbol: "Feature", direction: "callers" },
      {
        resolveAdapter: async (selection) => {
          sourceFileExtensions = selection?.sourceFileExtensions;
          return adapter(async (request) => ({
            workerVersion: "fixture", symbol: request.symbol, direction: request.direction,
            matchedSymbols: [], results: [], truncated: false,
            diagnostics: { ...diagnostics, filesRequested: 1, filesLoaded: 1 },
          }));
        },
      },
    );
    assert.deepEqual(sourceFileExtensions, [".cs", ".py"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("traceProject prioritizes target paths and explicit extension hints", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-context-graph-"));
  try {
    await mkdir(path.join(root, "src"));
    await writeProjectConfig(root, "version: 1\nsources:\n  code: [src]\n  documents: []\n");
    await writeFile(path.join(root, "src", "Feature.cs"), "class Feature {}\n", "utf8");
    await writeFile(path.join(root, "src", "View.prefab"), "%YAML 1.1\n", "utf8");
    await writeFile(path.join(root, "src", "helper.py"), "def helper(): pass\n", "utf8");
    const selections: Array<readonly string[] | undefined> = [];
    const resolveAdapter = async (selection?: {
      language?: string;
      sourceFileExtensions?: readonly string[];
    }) => {
      selections.push(selection?.sourceFileExtensions);
      return adapter(async (request) => ({
        workerVersion: "fixture",
        symbol: request.symbol,
        direction: request.direction,
        matchedSymbols: [],
        results: [],
        truncated: false,
        diagnostics: { ...diagnostics, filesRequested: 1, filesLoaded: 1 },
      }));
    };

    await traceProject(
      {
        projectPath: root,
        symbol: "src/View.prefab",
        direction: "callees",
      },
      { resolveAdapter },
    );
    await traceProject(
      {
        projectPath: root,
        symbol: "Feature.Target",
        direction: "callers",
        sourceFileExtensions: [".cs"],
      },
      { resolveAdapter },
    );

    assert.deepEqual(selections, [[".prefab"], [".cs"]]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
