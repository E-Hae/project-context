import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  GraphTraceError,
  getRoslynWorkerPath,
  traceProject,
  type TraceDirection,
} from "../src/graph-client.js";

const workerBuilt = existsSync(getRoslynWorkerPath());

test(
  "built Roslyn worker resolves relations and rejects ambiguous or spoofed symbols",
  { skip: !workerBuilt },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "project-context-roslyn-"));
    try {
      await mkdir(path.join(root, "src"));
      await writeFile(
        path.join(root, ".project-context.yml"),
        "version: 1\nsources:\n  code: [src]\n  documents: []\n  handoff:\n    enabled: false\n",
        "utf8",
      );
      await writeFile(
        path.join(root, "src", "Fixture.asmdef"),
        '{"name":"Fixture"}\n',
        "utf8",
      );
      await writeFile(
        path.join(root, "src", "Fixture.cs"),
        [
          "namespace UnityEngine { class MonoBehaviour {} }",
          "namespace Fixture",
          "{",
          "    class BaseFeature : UnityEngine.MonoBehaviour {}",
          "    interface IFeature {}",
          "    class Feature : BaseFeature, IFeature",
          "    {",
          "        public void Target() { Helper(); }",
          "        public void Overload() {}",
          "        public void Overload(int value) {}",
          "        private void Helper() {}",
          "        private void Update() {}",
          "    }",
          "    class Caller { public void Invoke() { new Feature().Target(); } }",
          "}",
          "",
        ].join("\n"),
        "utf8",
      );

      const trace = (symbol: string, direction: TraceDirection) =>
        traceProject({ projectPath: root, symbol, direction }, { timeoutMs: 30_000 });

      const callers = await trace("Feature.Target", "callers");
      assert.ok(callers.results.some((edge) => edge.from.fullName === "Fixture.Caller.Invoke"));
      const callees = await trace("Feature.Target", "callees");
      assert.ok(callees.results.some((edge) => edge.to.fullName === "Fixture.Feature.Helper"));
      const inherits = await trace("Feature", "inherits");
      assert.ok(inherits.results.some((edge) => edge.to.fullName === "Fixture.BaseFeature"));
      const implementsResult = await trace("Feature", "implements");
      assert.ok(implementsResult.results.some((edge) => edge.to.fullName === "Fixture.IFeature"));
      const spoofedUnity = await trace("Feature.Update", "callers");
      assert.ok(
        spoofedUnity.results.every((edge) => edge.relation !== "unity_message"),
      );
      await assert.rejects(
        trace("Feature.Overload", "callers"),
        (error: unknown) =>
          error instanceof GraphTraceError &&
          error.code === "ambiguous_symbol" &&
          error.candidates.length === 2,
      );
      const overload = await trace("Feature.Overload(int)", "callers");
      assert.equal(
        overload.matchedSymbols[0]?.signature,
        "Fixture.Feature.Overload(int)",
      );
      const brokenAsmdef = path.join(root, "src", "Broken.asmdef");
      await writeFile(brokenAsmdef, "{", "utf8");
      const partial = await trace("Feature.Target", "callers");
      assert.equal(partial.diagnostics.metadataFailures, 1);
      assert.equal(partial.diagnostics.partial, true);
      await rm(brokenAsmdef, { force: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
