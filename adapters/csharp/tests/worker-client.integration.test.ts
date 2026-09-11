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

test("C# adapter returns the types that inherit a class or implement an interface", { skip: !workerBuilt }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-context-csharp-subtypes-"));
  try {
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "States.cs"), [
      "namespace Fixture {",
      "  interface IRunnable { void Run(); }",
      "  interface IFastRunnable : IRunnable {}",
      "  class BaseState {}",
      "  class IdleState : BaseState, IRunnable { public void Run() {} }",
      "  class FastState : BaseState, IFastRunnable { public void Run() {} }",
      "}",
      "",
    ].join("\n"), "utf8");
    const trace = (symbol: string, direction: "derived" | "implementedBy") => traceAdapter.trace({
      projectRoot: root,
      files: ["src/States.cs"],
      auxiliaryFiles: [],
      symbol,
      direction,
      maxResults: 10,
    });
    const relations = (result: Awaited<ReturnType<typeof trace>>) =>
      result.results.map((edge) => `${edge.from.name} ${edge.relation} ${edge.to.name}`);

    assert.deepEqual(relations(await trace("BaseState", "derived")), [
      "IdleState inherits BaseState",
      "FastState inherits BaseState",
    ]);
    // implementedBy mirrors implements, which also reports an interface's base interfaces.
    assert.deepEqual(relations(await trace("IRunnable", "implementedBy")), [
      "IFastRunnable implements IRunnable",
      "IdleState implements IRunnable",
    ]);
    assert.deepEqual(relations(await trace("BaseState", "implementedBy")), []);
    assert.deepEqual(relations(await trace("IRunnable", "derived")), []);
    assert.deepEqual(traceAdapter.supportedDirections, [
      "callers", "callees", "inherits", "implements", "derived", "implementedBy",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("C# adapter names symbols that unresolved callers reference", { skip: !workerBuilt }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-context-csharp-missing-"));
  try {
    await mkdir(path.join(root, "src", "Gen"), { recursive: true });
    await writeFile(path.join(root, "src", "Gen", "Enums.cs"), [
      "[System.Flags]",
      "public enum TestFlag { None = 0, A = 1, B = 2 }",
      "",
    ].join("\n"), "utf8");
    await writeFile(path.join(root, "src", "Local.cs"), [
      "public static class Local",
      "{",
      "    private static TestFlag _flags;",
      "    public static bool Has(TestFlag flag) { return (_flags & flag) == flag; }",
      "}",
      "",
    ].join("\n"), "utf8");
    await writeFile(path.join(root, "src", "User.cs"), [
      "public class User",
      "{",
      "    private TestFlag _f;",
      "    public bool ViaLiteral() { return Local.Has(TestFlag.A); }",
      "    public bool ViaVariable() { return Local.Has(_f); }",
      "}",
      "",
    ].join("\n"), "utf8");
    const callers = (files: string[]) => traceAdapter.trace({
      projectRoot: root,
      files,
      auxiliaryFiles: [],
      symbol: "Local.Has",
      direction: "callers",
      maxResults: 10,
    });

    // Leaving out the declaring file is what an exclude entry does to a trace.
    const excluded = await callers(["src/Local.cs", "src/User.cs"]);
    assert.deepEqual(excluded.results.map((edge) => edge.from.name), ["ViaVariable"]);
    assert.equal(excluded.diagnostics.partial, true);
    assert.equal(excluded.diagnostics.metadata?.unresolvedCandidates, 1);
    assert.equal(excluded.diagnostics.metadata?.missingNames, "TestFlag");
    assert.match(excluded.diagnostics.messages[0] ?? "", /TestFlag.*semanticExclude/u);

    const included = await callers(["src/Gen/Enums.cs", "src/Local.cs", "src/User.cs"]);
    assert.deepEqual(included.results.map((edge) => edge.from.name), ["ViaLiteral", "ViaVariable"]);
    assert.equal(included.diagnostics.partial, false);
    assert.equal(included.diagnostics.metadata?.missingNames, undefined);
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
