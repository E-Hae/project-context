import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadProjectConfig } from "../src/config.js";
import {
  createGraphShard,
  graphManifestFingerprint,
  loadProjectGraph,
  saveProjectGraph,
} from "../src/graph-store.js";
import { deriveProjectIndexIdentity } from "../src/index-state.js";
import type { SemanticSearchResult } from "../src/result-format.js";
import { buildProjectSummary } from "../src/summary-indexer.js";
import { saveProjectSummary } from "../src/summary-store.js";
import { writeProjectConfig } from "./project-config-fixture.js";

export interface GraphRagSummaryFixture {
  root: string;
  stateRoot: string;
  /** Seeds `src/a/a.ts`, whose `a` calls `b`, `c`, and `d` in sibling directories. */
  semantic: SemanticSearchResult;
  cleanup: () => Promise<void>;
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** A fresh graph snapshot and hierarchy sidecar that GraphRAG can expand and summarize. */
export async function createGraphRagSummaryFixture(): Promise<GraphRagSummaryFixture> {
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
    return {
      root,
      stateRoot,
      semantic,
      cleanup: () => rm(root, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
