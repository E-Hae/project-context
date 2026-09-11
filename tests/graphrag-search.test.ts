import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { loadProjectConfig } from "../src/config.js";
import {
  createGraphShard,
  graphManifestFingerprint,
  loadProjectGraph,
  saveProjectGraph,
} from "../src/graph-store.js";
import { searchGraphRag } from "../src/graphrag-search.js";
import { deriveProjectIndexIdentity } from "../src/index-state.js";
import type { SemanticSearchResult } from "../src/result-format.js";
import { buildProjectSummary } from "../src/summary-indexer.js";
import { saveProjectSummary } from "../src/summary-store.js";
import { writeProjectConfig } from "./project-config-fixture.js";

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

test("GraphRAG bounds hierarchy summaries by maxResults and keeps the most relevant modules", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-context-graphrag-bounds-"));
  const stateRoot = path.join(root, "state");
  const indexedAt = "2026-09-11T00:00:00.000Z";
  const callerText = "export function a(): void { b(); c(); d(); }\n";
  try {
    await writeProjectConfig(root, "version: 1\nsources:\n  code: [src]\n  documents: []\n");
    const node = async (name: string, text: string) => {
      await mkdir(path.join(root, "src", name), { recursive: true });
      await writeFile(path.join(root, "src", name, `${name}.ts`), text, "utf8");
      return {
        name,
        fullName: name,
        signature: "(): void",
        kind: "function",
        path: `src/${name}/${name}.ts`,
        lineStart: 1,
        lineEnd: 1,
        fileHash: hash(text),
      };
    };
    const caller = await node("a", callerText);
    const callees = [
      await node("b", "export function b(): void {}\n"),
      await node("c", "export function c(): void {}\n"),
      await node("d", "export function d(): void {}\n"),
    ];
    const config = await loadProjectConfig(root);
    const identity = deriveProjectIndexIdentity(root, config.value);
    const shard = createGraphShard("typescript", "fixture", {
      workerVersion: "fixture/1.0",
      nodes: [caller, ...callees],
      results: callees.map((callee) => ({
        relation: "calls",
        from: caller,
        to: callee,
        evidence: { path: caller.path, lineStart: 1, lineEnd: 1, fileHash: caller.fileHash },
      })),
      diagnostics: { filesRequested: 4, filesLoaded: 4, filesSkipped: 0, partial: false, elapsedMs: 1, messages: [] },
      truncated: false,
    });
    await saveProjectGraph(identity, {
      projectRoot: root,
      projectSlug: identity.projectSlug,
      collectionName: identity.collectionName,
      indexedAt,
      commit: null,
      shards: [shard],
      diagnostics: [],
    }, stateRoot);
    const graph = await loadProjectGraph(identity, stateRoot);
    const hierarchy = buildProjectSummary({ config: config.value, graph: graph.value!, shards: [shard] });
    await saveProjectSummary(identity, {
      projectRoot: root,
      projectSlug: identity.projectSlug,
      collectionName: identity.collectionName,
      indexedAt,
      commit: null,
      graphFingerprint: graphManifestFingerprint(graph.value!),
      modules: hierarchy.modules,
      diagnostics: hierarchy.diagnostics,
      truncated: hierarchy.truncated,
    }, stateRoot);
    const semantic: SemanticSearchResult = {
      route: "semantic",
      fallbackUsed: false,
      query: "caller workflow",
      scope: "code",
      commit: null,
      indexCommit: null,
      indexedAt,
      stale: false,
      queryExpansion: { used: false, model: null, expandedQuery: null, identifierQuery: null, error: null },
      staleResultsSkipped: 0,
      results: [{
        source: "code",
        path: caller.path,
        matchKind: "semantic",
        lineStart: 1,
        lineEnd: 1,
        text: callerText.trim(),
        score: 0.9,
        indexedAt,
        commit: null,
      }],
      truncated: false,
    };
    const search = (maxResults: number) => searchGraphRag(
      { projectPath: root, query: "caller workflow", scope: "code", maxResults },
      { stateRoot, dependencies: { searchSemantic: async () => semantic } },
    );

    const wide = await search(10);
    const reached = (result: typeof wide) =>
      result.graph?.summaries?.modules.filter((module) => module.nodeCount > 0).map((module) => module.path);
    assert.deepEqual(reached(wide), ["src/a", "src/b", "src/c", "src/d"]);
    assert.equal(wide.graph?.summaries?.modules.find((module) => module.path === "src/a")?.edgeCount, 3);
    assert.equal(wide.graph?.summaries?.truncated, false);

    const narrow = await search(1);
    assert.deepEqual(reached(narrow), ["src/a"]);
    assert.deepEqual(narrow.graph?.summaries?.modules.map((module) => module.id), [
      "project",
      "root:src",
      "directory:src/a",
    ]);
    assert.equal(narrow.graph?.summaries?.truncated, true);
    assert.equal(narrow.graph?.summaries?.modules.every((module) => module.nodes.length <= 1), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("GraphRAG expands a verified vector seed through a stored source graph", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-context-graphrag-"));
  const stateRoot = path.join(root, "state");
  const featureText = "export function feature(): void {}\n";
  const callerText = "import { feature } from './feature.js';\nexport function invoke(): void { feature(); }\n";
  const edgeText = "// invoke calls feature\n";
  try {
    await mkdir(path.join(root, "src"));
    await writeProjectConfig(root, "version: 1\nsources:\n  code: [src]\n  documents: []\n");
    await writeFile(path.join(root, "src", "feature.ts"), featureText, "utf8");
    await writeFile(path.join(root, "src", "caller.ts"), callerText, "utf8");
    await writeFile(path.join(root, "src", "edge.ts"), edgeText, "utf8");
    const config = await loadProjectConfig(root);
    const identity = deriveProjectIndexIdentity(root, config.value);
    const feature = {
      name: "feature",
      fullName: "feature",
      signature: "(): void",
      kind: "function",
      path: "src/feature.ts",
      lineStart: 1,
      lineEnd: 1,
      fileHash: hash(featureText),
    } as const;
    const invoke = {
      name: "invoke",
      fullName: "invoke",
      signature: "(): void",
      kind: "function",
      path: "src/caller.ts",
      lineStart: 2,
      lineEnd: 2,
      fileHash: hash(callerText),
    } as const;
    const shard = createGraphShard("typescript", "fixture", {
      workerVersion: "fixture/1.0",
      nodes: [feature, invoke],
      results: [{
        relation: "calls",
        from: invoke,
        to: feature,
        evidence: {
          path: "src/edge.ts",
          lineStart: 1,
          lineEnd: 1,
          fileHash: hash(edgeText),
        },
      }],
      diagnostics: {
        filesRequested: 2,
        filesLoaded: 2,
        filesSkipped: 0,
        partial: false,
        elapsedMs: 1,
        messages: [],
      },
      truncated: false,
    });
    await saveProjectGraph(identity, {
      projectRoot: root,
      projectSlug: identity.projectSlug,
      collectionName: identity.collectionName,
      indexedAt: "2026-08-05T00:00:00.000Z",
      commit: null,
      shards: [shard],
      diagnostics: [],
    }, stateRoot);
    const graph = await loadProjectGraph(identity, stateRoot);
    assert.equal(graph.valid, true);
    const hierarchy = buildProjectSummary({
      config: config.value,
      graph: graph.value!,
      shards: [shard],
    });
    const saveHierarchy = async (graphFingerprint = graphManifestFingerprint(graph.value!)) =>
      saveProjectSummary(identity, {
        projectRoot: root,
        projectSlug: identity.projectSlug,
        collectionName: identity.collectionName,
        indexedAt: "2026-08-05T00:00:00.000Z",
        commit: null,
        graphFingerprint,
        modules: hierarchy.modules,
        diagnostics: hierarchy.diagnostics,
        truncated: hierarchy.truncated,
      }, stateRoot);
    await saveHierarchy();
    const semantic: SemanticSearchResult = {
      route: "semantic",
      fallbackUsed: false,
      query: "feature workflow",
      scope: "code",
      commit: null,
      indexCommit: null,
      indexedAt: "2026-08-05T00:00:00.000Z",
      stale: false,
      queryExpansion: { used: false, model: null, expandedQuery: null, identifierQuery: null, error: null },
      staleResultsSkipped: 0,
      results: [{
        source: "code",
        path: "src/feature.ts",
        matchKind: "semantic",
        lineStart: 1,
        lineEnd: 1,
        text: featureText.trim(),
        score: 0.9,
        indexedAt: "2026-08-05T00:00:00.000Z",
        commit: null,
      }],
      truncated: false,
    };
    const result = await searchGraphRag(
      { projectPath: root, query: "feature workflow", scope: "code", maxResults: 10 },
      { stateRoot, dependencies: { searchSemantic: async () => semantic } },
    );
    assert.equal(result?.route, "graphrag");
    assert.equal(result?.graph?.seedNodes, 1);
    assert.equal(result?.graph?.expandedNodes, 1);
    assert.equal(result?.results.some((entry) => entry.path === "src/caller.ts"), true);
    assert.equal(result.graph?.summaries?.modules.some((module) =>
      module.nodes.some((node) => node.path === "src/caller.ts")), true);
    assert.equal(result.graph?.summaries?.modules.some((module) => module.edgeCount > 0), true);
    assert.equal(result.graph?.summaries?.modules.every((module) =>
      module.parentId === null || result.graph?.summaries?.modules.some((parent) => parent.id === module.parentId)), true);
    const reached = result.graph?.summaries?.modules.find((module) => module.nodeCount > 0);
    assert.deepEqual(reached?.nodes.map((node) => Object.keys(node).sort()), [
      ["lineEnd", "lineStart", "path"],
      ["lineEnd", "lineStart", "path"],
    ]);
    assert.deepEqual(Object.keys(reached ?? {}).sort(), [
      "edgeCount", "id", "kind", "nodeCount", "nodes", "parentId", "path",
    ]);
    await saveHierarchy("f".repeat(64));
    const mismatchedSummary = await searchGraphRag(
      { projectPath: root, query: "feature workflow", scope: "code", maxResults: 10 },
      { stateRoot, dependencies: { searchSemantic: async () => semantic } },
    );
    assert.equal(mismatchedSummary.graph?.expandedNodes, 1);
    assert.equal(mismatchedSummary.graph?.summaries, undefined);
    await saveHierarchy();
    await writeFile(path.join(root, "src", "edge.ts"), "// changed relationship\n", "utf8");
    const staleGraph = await searchGraphRag(
      { projectPath: root, query: "feature workflow", scope: "code", maxResults: 10 },
      { stateRoot, dependencies: { searchSemantic: async () => semantic } },
    );
    assert.equal(staleGraph.graph?.expandedNodes, 0);
    assert.equal(staleGraph.graph?.staleEdgesSkipped, 1);
    assert.equal(staleGraph.results.some((entry) => entry.path === "src/caller.ts"), false);
    assert.equal(staleGraph.graph?.summaries?.modules.some((module) => module.edgeCount > 0), false);
    await writeFile(path.join(root, "src", "edge.ts"), edgeText, "utf8");
    await writeFile(path.join(root, "src", "caller.ts"), "// caller changed\n", "utf8");
    const staleEndpoint = await searchGraphRag(
      { projectPath: root, query: "feature workflow", scope: "code", maxResults: 10 },
      { stateRoot, dependencies: { searchSemantic: async () => semantic } },
    );
    assert.equal(staleEndpoint.graph?.summaries?.modules.some((module) => module.edgeCount > 0), false);
    await writeFile(path.join(root, "src", "caller.ts"), callerText, "utf8");
    const edgeLess = createGraphShard("typescript", "fixture", {
      workerVersion: "fixture/1.0",
      nodes: [feature],
      results: [],
      diagnostics: shard.diagnostics,
      truncated: false,
    });
    await saveProjectGraph(identity, {
      projectRoot: root,
      projectSlug: identity.projectSlug,
      collectionName: identity.collectionName,
      indexedAt: "2026-08-05T00:00:00.000Z",
      commit: null,
      shards: [edgeLess],
      diagnostics: [],
    }, stateRoot);
    const edgeLessManifest = await loadProjectGraph(identity, stateRoot);
    const edgeLessSummary = buildProjectSummary({
      config: config.value,
      graph: edgeLessManifest.value!,
      shards: [edgeLess],
    });
    await saveProjectSummary(identity, {
      projectRoot: root,
      projectSlug: identity.projectSlug,
      collectionName: identity.collectionName,
      indexedAt: "2026-08-05T00:00:00.000Z",
      commit: null,
      graphFingerprint: graphManifestFingerprint(edgeLessManifest.value!),
      modules: edgeLessSummary.modules,
      diagnostics: edgeLessSummary.diagnostics,
      truncated: edgeLessSummary.truncated,
    }, stateRoot);
    const edgeLessResult = await searchGraphRag(
      { projectPath: root, query: "feature workflow", scope: "code", maxResults: 10 },
      { stateRoot, dependencies: { searchSemantic: async () => semantic } },
    );
    assert.equal(edgeLessResult.graph?.seedNodes, 1);
    assert.equal(edgeLessResult.graph?.expandedNodes, 0);
    assert.equal(edgeLessResult.graph?.summaries?.modules.some((module) =>
      module.nodes.some((node) => node.path === "src/feature.ts")), true);

    const mismatchedIndexedAt = await searchGraphRag(
      { projectPath: root, query: "feature workflow", scope: "code", maxResults: 10 },
      {
        stateRoot,
        dependencies: {
          searchSemantic: async () => ({ ...semantic, indexedAt: "2026-08-05T00:00:01.000Z" }),
        },
      },
    );
    assert.equal(mismatchedIndexedAt.graph, undefined);
    assert.equal(mismatchedIndexedAt.route, "semantic");
    const mismatchedCommit = await searchGraphRag(
      { projectPath: root, query: "feature workflow", scope: "code", maxResults: 10 },
      {
        stateRoot,
        dependencies: {
          searchSemantic: async () => ({ ...semantic, indexCommit: "different-commit" }),
        },
      },
    );
    assert.equal(mismatchedCommit.graph, undefined);
    const oversized: SemanticSearchResult = {
      ...semantic,
      results: Array.from({ length: 6 }, (_, index) => ({
        ...semantic.results[0]!,
        path: `src/result-${index}.ts`,
      })),
    };
    const fallback = await searchGraphRag(
      { projectPath: root, query: "documents", scope: "documents", maxResults: 2 },
      { stateRoot, dependencies: { searchSemantic: async () => oversized } },
    );
    assert.equal(fallback.graph, undefined);
    assert.equal(fallback.results.length, 2);
    assert.equal(fallback.truncated, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
