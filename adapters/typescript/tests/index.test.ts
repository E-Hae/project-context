import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { traceAdapter } from "../src/index.js";

async function createFixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "project-context-typescript-"));
  await writeFile(
    path.join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        target: "ES2022",
        allowJs: true,
      },
    }),
    "utf8",
  );
  await writeFile(
    path.join(root, "base.ts"),
    [
      "export interface Runnable {",
      "  run(): void;",
      "}",
      "export class Base {",
      "  protected base(): void {}",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(root, "derived.ts"),
    [
      "import { Base, Runnable } from './base.js';",
      "export class Derived extends Base implements Runnable {",
      "  run(): void { this.base(); }",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(root, "caller.ts"),
    [
      "import { Derived } from './derived.js';",
      "import { helper } from './helper.js';",
      "export function invoke(): void {",
      "  const derived = new Derived();",
      "  derived.run();",
      "  helper();",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(path.join(root, "helper.js"), "export function helper() { return 1; }\n", "utf8");
  return root;
}

const requestFiles = ["base.ts", "derived.ts", "caller.ts", "helper.js"];
const requestAuxiliaryFiles = ["tsconfig.json"];

test("TypeScript adapter exposes JavaScript support and probes without an external worker", async () => {
  const probe = await traceAdapter.probe();

  assert.equal(probe.available, true);
  assert.equal(traceAdapter.language, "typescript");
  assert.deepEqual(traceAdapter.languageAliases, ["javascript", "js"]);
  assert.deepEqual(traceAdapter.sourceFileExtensions, [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
  assert.equal(probe.metadata?.javascriptSupport, true);
});

test("TypeScript adapter traces calls and type relationships with source evidence", async () => {
  const root = await createFixture();
  try {
    const baseRequest = {
      projectRoot: root,
      files: requestFiles,
      auxiliaryFiles: requestAuxiliaryFiles,
      maxResults: 20,
    } as const;

    const callers = await traceAdapter.trace({ ...baseRequest, symbol: "run", direction: "callers" });
    assert.equal(callers.results.length, 1);
    assert.equal(callers.results[0]?.relation, "calls");
    assert.equal(callers.results[0]?.from.name, "invoke");
    assert.equal(callers.results[0]?.to.name, "run");
    assert.equal(callers.results[0]?.evidence.path, "caller.ts");

    const callees = await traceAdapter.trace({ ...baseRequest, symbol: "invoke", direction: "callees" });
    assert.equal(callees.results.some((result) => result.relation === "constructs" && result.to.name === "Derived"), true);
    assert.equal(callees.results.some((result) => result.relation === "calls" && result.to.name === "run"), true);
    assert.equal(callees.results.some((result) => result.relation === "calls" && result.to.name === "helper"), true);

    const inherits = await traceAdapter.trace({ ...baseRequest, symbol: "Derived", direction: "inherits" });
    assert.equal(inherits.results[0]?.relation, "inherits");
    assert.equal(inherits.results[0]?.to.name, "Base");
    assert.equal(inherits.results[0]?.evidence.path, "derived.ts");

    const implementsResult = await traceAdapter.trace({ ...baseRequest, symbol: "Derived", direction: "implements" });
    assert.equal(implementsResult.results[0]?.relation, "implements");
    assert.equal(implementsResult.results[0]?.to.name, "Runnable");
    assert.equal(implementsResult.diagnostics.metadata?.allowJs, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("TypeScript adapter builds a bounded whole-project source graph", async () => {
  const root = await createFixture();
  try {
    const graph = await traceAdapter.buildGraph!({
      projectRoot: root,
      files: requestFiles,
      auxiliaryFiles: requestAuxiliaryFiles,
      maxNodes: 100,
      maxEdges: 100,
    });
    assert.equal(graph.nodes.some((node) => node.name === "invoke"), true);
    assert.equal(graph.results.some((edge) =>
      edge.relation === "calls" && edge.from.name === "invoke" && edge.to.name === "run"), true);
    assert.equal(graph.results.some((edge) =>
      edge.relation === "implements" && edge.from.name === "Derived" && edge.to.name === "Runnable"), true);
    assert.equal(graph.results.every((edge) => "text" in edge.evidence === false), true);
    const bounded = await traceAdapter.buildGraph!({
      projectRoot: root,
      files: requestFiles,
      auxiliaryFiles: requestAuxiliaryFiles,
      maxNodes: 1,
      maxEdges: 1,
    });
    assert.equal(bounded.nodes.length, 1);
    assert.equal(bounded.results.length, 1);
    assert.equal(bounded.truncated, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
