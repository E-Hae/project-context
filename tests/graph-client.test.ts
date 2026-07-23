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
  type RoslynWorkerRequest,
} from "../src/graph-client.js";

const diagnostics = {
  filesRequested: 2,
  filesLoaded: 2,
  filesSkipped: 0,
  metadataFailures: 0,
  projectFilesRead: 0,
  assemblyDefinitionsLoaded: 1,
  referencesLoaded: 1,
  referenceFailures: 0,
  parseErrors: 0,
  unresolvedCandidates: 0,
  partial: false,
  elapsedMs: 10,
  messages: [],
};

function node(
  name: string,
  fullName: string,
  sourcePath: string,
  line: number,
  fileHash: string,
): GraphSymbolNode {
  return {
    name,
    fullName,
    signature: `${fullName}()`,
    kind: "method",
    assembly: "Fixture",
    path: sourcePath,
    lineStart: line,
    lineEnd: line,
    fileHash,
    unityMessage: false,
  };
}

test("traceProject limits worker input and re-reads source evidence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-context-graph-"));
  try {
    await mkdir(path.join(root, "src"));
    await writeFile(
      path.join(root, ".project-context.yml"),
      [
        "version: 1",
        "sources:",
        "  code: [src]",
        "  documents: []",
        "  handoff:",
        "    enabled: false",
        "exclude:",
        "  - src/Excluded.cs",
        "",
      ].join("\n"),
      "utf8",
    );
    const featurePath = path.join(root, "src", "Feature.cs");
    await writeFile(
      featurePath,
      "class Feature { public void Target() {} }\n",
      "utf8",
    );
    const callerContent = [
      "class Caller {",
      "  void Invoke() { new Feature().Target(); }",
      "}",
      "",
    ].join("\n");
    const callerPath = path.join(root, "src", "Caller.cs");
    await writeFile(callerPath, callerContent, "utf8");
    await writeFile(
      path.join(root, "src", "Excluded.cs"),
      "class Excluded {}\n",
      "utf8",
    );
    await writeFile(
      path.join(root, "src", "Fixture.asmdef"),
      '{"name":"Fixture"}\n',
      "utf8",
    );
    const fileHash = createHash("sha256")
      .update(await readFile(callerPath))
      .digest("hex");
    const featureHash = createHash("sha256")
      .update(await readFile(featurePath))
      .digest("hex");
    const captured: { request?: RoslynWorkerRequest } = {};

    const result = await traceProject(
      {
        projectPath: root,
        symbol: "Feature.Target",
        direction: "callers",
      },
      {
        now: () => new Date("2026-07-14T00:00:00.000Z"),
        dependencies: {
          runWorker: async (request) => {
            captured.request = request;
            return {
              version: 1,
              ok: true,
              workerVersion: "fixture-worker/1.0",
              symbol: request.symbol,
              direction: request.direction,
              matchedSymbols: [
                node("Target", "Feature.Target", "src/Feature.cs", 1, featureHash),
              ],
              results: [
                {
                  relation: "calls",
                  from: node("Invoke", "Caller.Invoke", "src/Caller.cs", 2, fileHash),
                  to: node("Target", "Feature.Target", "src/Feature.cs", 1, featureHash),
                  evidence: {
                    path: "src/Caller.cs",
                    lineStart: 2,
                    lineEnd: 2,
                    text: "untrusted worker excerpt",
                    fileHash,
                  },
                },
              ],
              truncated: false,
              diagnostics,
            };
          },
        },
      },
    );

    assert.deepEqual(captured.request?.files, ["src/Caller.cs", "src/Feature.cs"]);
    assert.deepEqual(captured.request?.assemblyDefinitions, ["src/Fixture.asmdef"]);
    assert.equal(result.route, "graph");
    assert.equal(result.results[0]?.evidence.text, "void Invoke() { new Feature().Target(); }");
    assert.equal(result.stale, false);
    assert.equal(result.analyzedAt, "2026-07-14T00:00:00.000Z");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("traceProject skips changed evidence and rejects worker path escape", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-context-graph-"));
  try {
    await mkdir(path.join(root, "src"));
    await writeFile(
      path.join(root, ".project-context.yml"),
      "version: 1\nsources:\n  code: [src]\n  documents: []\n  handoff:\n    enabled: false\n",
      "utf8",
    );
    const sourcePath = path.join(root, "src", "Feature.cs");
    await writeFile(sourcePath, "class Feature { void Target() {} }\n", "utf8");
    const originalHash = createHash("sha256")
      .update(await readFile(sourcePath))
      .digest("hex");
    const featureNode = node(
      "Target",
      "Feature.Target",
      "src/Feature.cs",
      1,
      originalHash,
    );

    const stale = await traceProject(
      { projectPath: root, symbol: "Feature.Target", direction: "callers" },
      {
        dependencies: {
          runWorker: async (request) => {
            await writeFile(sourcePath, "class Feature { void Target() { } }\n", "utf8");
            return {
              version: 1,
              ok: true,
              workerVersion: "fixture-worker/1.0",
              symbol: request.symbol,
              direction: request.direction,
              matchedSymbols: [featureNode],
              results: [
                {
                  relation: "calls",
                  from: featureNode,
                  to: featureNode,
                  evidence: {
                    path: "src/Feature.cs",
                    lineStart: 1,
                    lineEnd: 1,
                    text: "",
                    fileHash: originalHash,
                  },
                },
              ],
              truncated: false,
              diagnostics: { ...diagnostics, filesRequested: 1, filesLoaded: 1 },
            };
          },
        },
      },
    );
    assert.equal(stale.stale, true);
    assert.equal(stale.staleResultsSkipped, 1);
    assert.equal(stale.staleSymbolsSkipped, 1);
    assert.equal(stale.results.length, 0);

    await assert.rejects(
      traceProject(
        { projectPath: root, symbol: "Feature.Target", direction: "callers" },
        {
          dependencies: {
            runWorker: async (request) => ({
              version: 1,
              ok: true,
              workerVersion: "fixture-worker/1.0",
              symbol: request.symbol,
              direction: request.direction,
              matchedSymbols: [{ ...featureNode, path: "../secret.cs" }],
              results: [],
              truncated: false,
              diagnostics: { ...diagnostics, filesRequested: 1, filesLoaded: 1 },
            }),
          },
        },
      ),
      (error: unknown) =>
        error instanceof GraphTraceError && error.code === "worker_protocol",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
