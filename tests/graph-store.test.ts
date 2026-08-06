import assert from "node:assert/strict";
import { readdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createGraphShard,
  loadGraphShard,
  loadProjectGraph,
  saveProjectGraph,
} from "../src/graph-store.js";
import { deriveProjectIndexIdentity } from "../src/index-state.js";
import { writeProjectConfig } from "./project-config-fixture.js";
import { loadProjectConfig } from "../src/config.js";

function graphShard(language: string, adapter: string) {
  return createGraphShard(language, adapter, {
    workerVersion: "fixture/1.0",
    nodes: [{
      name: adapter,
      fullName: adapter,
      signature: "fixture()",
      kind: "fixture",
      path: null,
      lineStart: null,
      lineEnd: null,
      fileHash: null,
    }],
    results: [],
    diagnostics: {
      filesRequested: 0,
      filesLoaded: 0,
      filesSkipped: 0,
      partial: false,
      elapsedMs: 0,
      messages: [],
    },
    truncated: false,
  });
}

test("graph snapshots use immutable files and preserve same-language adapters", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-context-graph-store-"));
  const stateRoot = path.join(root, "state");
  try {
    await writeProjectConfig(root, "version: 1\n");
    const config = await loadProjectConfig(root);
    const identity = deriveProjectIndexIdentity(root, config.value);
    const save = async (indexedAt: string) => saveProjectGraph(identity, {
      projectRoot: root,
      projectSlug: identity.projectSlug,
      collectionName: identity.collectionName,
      indexedAt,
      commit: null,
      shards: [
        graphShard("fixture", "adapter-a"),
        graphShard("fixture", "adapter-b"),
      ],
      diagnostics: [],
    }, stateRoot);

    await save("2026-08-05T00:00:00.000Z");
    const first = await loadProjectGraph(identity, stateRoot);
    assert.equal(first.valid, true);
    assert.equal(first.value?.shards.length, 2);
    const firstFiles = first.value!.shards.map((entry) => entry.file);
    assert.equal(new Set(firstFiles).size, 2);
    for (const entry of first.value!.shards) {
      assert.equal((await loadGraphShard(identity, entry, stateRoot)).valid, true);
    }

    await save("2026-08-05T00:00:01.000Z");
    const second = await loadProjectGraph(identity, stateRoot);
    const secondFiles = second.value!.shards.map((entry) => entry.file);
    assert.equal(secondFiles.some((file) => firstFiles.includes(file)), false);
    const files = await readdir(stateRoot);
    for (const file of firstFiles) assert.equal(files.includes(file), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("graph shard node caps do not leave edges with omitted endpoints", () => {
  const nodes = Array.from({ length: 20_000 }, (_, index) => ({
    name: `node-${index}`,
    fullName: `node-${index}`,
    signature: `node-${index}()`,
    kind: "fixture",
    path: null,
    lineStart: null,
    lineEnd: null,
    fileHash: null,
  }));
  const overflow = {
    name: "overflow",
    fullName: "overflow",
    signature: "overflow()",
    kind: "fixture",
    path: null,
    lineStart: null,
    lineEnd: null,
    fileHash: null,
  };
  const shard = createGraphShard("fixture", "adapter", {
    workerVersion: "fixture/1.0",
    nodes,
    results: [{
      relation: "calls",
      from: nodes[0]!,
      to: overflow,
      evidence: {
        path: "src/fixture.ts",
        lineStart: 1,
        lineEnd: 1,
        fileHash: "a".repeat(64),
      },
    }],
    diagnostics: {
      filesRequested: 0,
      filesLoaded: 0,
      filesSkipped: 0,
      partial: false,
      elapsedMs: 0,
      messages: [],
    },
    truncated: false,
  });
  assert.equal(shard.nodes.length, 20_000);
  assert.equal(shard.edges.length, 0);
  assert.equal(shard.truncated, true);
});

test("graph shard checksums reject changed snapshot content", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-context-graph-checksum-"));
  const stateRoot = path.join(root, "state");
  try {
    await writeProjectConfig(root, "version: 1\n");
    const config = await loadProjectConfig(root);
    const identity = deriveProjectIndexIdentity(root, config.value);
    await saveProjectGraph(identity, {
      projectRoot: root,
      projectSlug: identity.projectSlug,
      collectionName: identity.collectionName,
      indexedAt: "2026-08-05T00:00:00.000Z",
      commit: null,
      shards: [graphShard("fixture", "adapter")],
      diagnostics: [],
    }, stateRoot);
    const manifest = await loadProjectGraph(identity, stateRoot);
    const entry = manifest.value!.shards[0]!;
    const shardPath = path.join(stateRoot, entry.file);
    const changed = JSON.parse(await readFile(shardPath, "utf8")) as { truncated: boolean };
    changed.truncated = true;
    await writeFile(shardPath, JSON.stringify(changed), "utf8");
    const loaded = await loadGraphShard(identity, entry, stateRoot);
    assert.equal(loaded.valid, false);
    assert.match(loaded.errors.join(" "), /manifest/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
