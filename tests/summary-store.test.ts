import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { loadProjectConfig } from "../src/config.js";
import { createGraphShard, type ProjectGraphManifest } from "../src/graph-store.js";
import { deriveProjectIndexIdentity } from "../src/index-state.js";
import { buildProjectSummary } from "../src/summary-indexer.js";
import {
  loadProjectSummary,
  loadProjectSummaryPayload,
  saveProjectSummary,
} from "../src/summary-store.js";
import { writeProjectConfig } from "./project-config-fixture.js";

const hash = "a".repeat(64);

test("hierarchy summaries use an immutable payload with manifest guards", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-context-summary-store-"));
  const stateRoot = path.join(root, "state");
  try {
    await writeProjectConfig(root, "version: 1\n");
    const config = await loadProjectConfig(root);
    const identity = deriveProjectIndexIdentity(root, config.value);
    const save = async (indexedAt: string) => saveProjectSummary(identity, {
      projectRoot: root,
      projectSlug: identity.projectSlug,
      collectionName: identity.collectionName,
      indexedAt,
      commit: null,
      graphFingerprint: hash,
      modules: [{
        id: "project",
        parentId: null,
        kind: "project",
        path: null,
        nodes: [],
        edges: [],
        sources: [],
      }],
      diagnostics: [],
      truncated: false,
    }, stateRoot);

    await save("2026-08-05T00:00:00.000Z");
    const first = await loadProjectSummary(identity, stateRoot);
    assert.equal(first.valid, true);
    assert.equal(first.value?.moduleCount, 1);
    const firstFile = first.value!.file;
    assert.equal((await loadProjectSummaryPayload(identity, first.value!, stateRoot)).valid, true);
    const mismatched = await loadProjectSummaryPayload(identity, {
      ...first.value!,
      graphFingerprint: "b".repeat(64),
    }, stateRoot);
    assert.equal(mismatched.valid, false);

    await save("2026-08-05T00:00:01.000Z");
    const second = await loadProjectSummary(identity, stateRoot);
    assert.notEqual(second.value?.file, firstFile);
    assert.equal((await loadProjectSummaryPayload(identity, second.value!, stateRoot)).valid, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("hierarchy summaries prune locators deterministically to their byte budget", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-context-summary-budget-"));
  try {
    await writeProjectConfig(root, "version: 1\nsources:\n  code: [src]\n  documents: []\n");
    const config = await loadProjectConfig(root);
    const nodes = Array.from({ length: 40 }, (_, index) => ({
      name: `node${index}`,
      fullName: `node${index}`,
      signature: "fixture()",
      kind: "fixture",
      path: `src/deep/file-${index}.ts`,
      lineStart: 1,
      lineEnd: 1,
      fileHash: hash,
    }));
    const shard = createGraphShard("fixture", "fixture", {
      workerVersion: "fixture/1.0",
      nodes,
      results: [],
      diagnostics: {
        filesRequested: nodes.length,
        filesLoaded: nodes.length,
        filesSkipped: 0,
        partial: false,
        elapsedMs: 0,
        messages: [],
      },
      truncated: false,
    });
    const graph: ProjectGraphManifest = {
      version: 2,
      projectRoot: root,
      projectSlug: "fixture",
      collectionName: "fixture",
      indexedAt: "2026-08-05T00:00:00.000Z",
      commit: null,
      shards: [],
      diagnostics: [],
    };
    const result = buildProjectSummary(
      { config: config.value, graph, shards: [shard] },
      { byteBudget: 1_500 },
    );
    assert.equal(result.truncated, true);
    assert.ok(result.modules.flatMap((module) => module.nodes).length < nodes.length);
    assert.ok(Buffer.byteLength(JSON.stringify({ modules: result.modules }), "utf8") <= 1_500);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
