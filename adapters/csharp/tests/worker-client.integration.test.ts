import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { getRoslynWorkerPath, runRoslynWorker } from "../src/worker-client.js";
import { traceAdapter } from "../src/index.js";

const workerBuilt = existsSync(getRoslynWorkerPath());

test("C# worker accepts bounded C# and asmdef inputs", { skip: !workerBuilt }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-context-csharp-worker-"));
  try {
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "Fixture.asmdef"), "{\"name\":\"Fixture\"}\n", "utf8");
    await writeFile(path.join(root, "src", "Feature.cs"), [
      "namespace Fixture {",
      "  class Feature { public void Target() {} }",
      "  class Caller { void Invoke() { new Feature().Target(); } }",
      "}",
      "",
    ].join("\n"), "utf8");
    const response = await runRoslynWorker({
      version: 1,
      projectRoot: root,
      files: ["src/Feature.cs"],
      assemblyDefinitions: ["src/Fixture.asmdef"],
      symbol: "Feature.Target",
      direction: "callers",
      maxResults: 10,
    });
    assert.equal(typeof response, "object");
    assert.equal((response as { ok?: unknown }).ok, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("C# trace adapter preserves the core request contract", { skip: !workerBuilt }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-context-csharp-adapter-"));
  try {
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "Fixture.asmdef"), "{\"name\":\"Fixture\"}\n", "utf8");
    await writeFile(path.join(root, "src", "Feature.cs"), [
      "namespace Fixture {",
      "  class Feature { public void Target() {} }",
      "  class Caller { void Invoke() { new Feature().Target(); } }",
      "}",
      "",
    ].join("\n"), "utf8");
    const result = await traceAdapter.trace({
      projectRoot: root,
      files: ["src/Feature.cs"],
      auxiliaryFiles: ["src/Fixture.asmdef"],
      symbol: "Feature.Target",
      direction: "callers",
      maxResults: 10,
    });
    assert.equal(result.symbol, "Feature.Target");
    assert.equal(result.direction, "callers");
    assert.ok(result.results.length > 0);
    assert.equal((await traceAdapter.probe()).available, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("C# adapter builds a bounded Roslyn source graph", { skip: !workerBuilt }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-context-csharp-graph-"));
  try {
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "Fixture.asmdef"), "{\"name\":\"Fixture\"}\n", "utf8");
    await writeFile(path.join(root, "src", "Feature.cs"), [
      "namespace Fixture {",
      "  class Feature { public void Target() {} }",
      "  class Caller { void Invoke() { new Feature().Target(); } }",
      "}",
      "",
    ].join("\n"), "utf8");
    const graph = await traceAdapter.buildGraph!({
      projectRoot: root,
      files: ["src/Feature.cs"],
      auxiliaryFiles: ["src/Fixture.asmdef"],
      maxNodes: 100,
      maxEdges: 100,
    });
    assert.equal(graph.nodes.some((node) => node.name === "Invoke"), true);
    assert.equal(graph.results.some((edge) => edge.relation === "calls"), true);
    assert.equal(graph.results.every((edge) => "text" in edge.evidence === false), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
