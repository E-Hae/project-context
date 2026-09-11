import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { loadProjectConfig } from "../src/config.js";
import type { EmbeddingProvider } from "../src/embedding-client.js";
import {
  deriveProjectIndexIdentity,
  saveProjectIndexState,
} from "../src/index-state.js";
import type {
  ProjectContextVectorStore,
  VectorEntity,
  VectorSearchHit,
} from "../src/milvus-rest-client.js";
import { searchSemantic } from "../src/semantic-search.js";
import { createLinkedWorktree, gitAvailable } from "./git-worktree-fixture.js";
import { writeProjectConfig } from "./project-config-fixture.js";

test("searchSemantic returns one fresh evidence result per file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-context-semantic-"));
  const stateRoot = path.join(root, "state");
  try {
    await mkdir(path.join(root, "src"));
    await mkdir(path.join(root, "docs"));
    await writeProjectConfig(
      root,
      "version: 1\nsources:\n  code: [src]\n  documents: [docs]\nservices:\n  ollama:\n    embeddingModel: fixture-embedding\n",
    );
    const codePath = path.join(root, "src", "Feature.cs");
    const docsPath = path.join(root, "docs", "design.md");
    await writeFile(codePath, "public class Feature {}\n", "utf8");
    await writeFile(docsPath, "# Storage\nDesign details\n", "utf8");
    const codeHash = createHash("sha256").update(await readFile(codePath)).digest("hex");
    const docsHash = createHash("sha256").update(await readFile(docsPath)).digest("hex");
    const config = (await loadProjectConfig(root)).value;
    const identity = deriveProjectIndexIdentity(root, config);
    await saveProjectIndexState(
      identity,
      {
        version: 1,
        chunkerVersion: 3,
        projectRoot: root,
        projectSlug: identity.projectSlug,
        collectionName: identity.collectionName,
        vectorStoreBackend: "local",
        embeddingModel: "fixture-embedding",
        embeddingDimension: 2,
        indexedAt: "2026-07-14T00:00:00.000Z",
        commit: null,
        files: {
          "src/Feature.cs": { hash: codeHash, source: "code", chunkIds: [] },
          "docs/design.md": { hash: docsHash, source: "document", chunkIds: [] },
        },
      },
      stateRoot,
    );
    let queryEmbeddingAttempts = 0;
    const embedding: EmbeddingProvider = {
      model: "fixture-embedding",
      async probeDimension() { return 2; },
      async embedDocuments(texts) { return texts.map(() => [1, 0]); },
      async embedQuery() {
        queryEmbeddingAttempts += 1;
        if (queryEmbeddingAttempts === 1) throw new Error("HTTP 503");
        return [1, 0];
      },
    };
    const hits: VectorSearchHit[] = [
      {
        id: "a".repeat(64), source: "code", path: "src/Feature.cs",
        lineStart: 1, lineEnd: 1, content: "public class Feature {}",
        fileHash: codeHash, indexedAt: "2026-07-14T00:00:00.000Z",
        commit: null, score: 0.95,
      },
      {
        id: "b".repeat(64), source: "code", path: "src/Feature.cs",
        lineStart: 1, lineEnd: 1, content: "duplicate",
        fileHash: codeHash, indexedAt: "2026-07-14T00:00:00.000Z",
        commit: null, score: 0.9,
      },
      {
        id: "c".repeat(64), source: "document", path: "docs/design.md",
        lineStart: 1, lineEnd: 2, content: "# Storage\nDesign details",
        fileHash: docsHash, indexedAt: "2026-07-14T00:00:00.000Z",
        commit: null, score: 0.8,
      },
    ];
    const store: ProjectContextVectorStore = {
      async hasCollection() { return true; },
      async ensureCollection() {},
      async dropCollection() {},
      async upsert(_name: string, _entities: VectorEntity[]) {},
      async deleteIds() {},
      async search() { return hits; },
    };

    const result = await searchSemantic(
      { projectPath: root, query: "where is storage?", maxResults: 51 },
      {
        stateRoot,
        dependencies: {
          createEmbeddingProvider: () => embedding,
          createVectorStore: () => store,
          createQueryExpander: () => null,
          sleep: async () => {},
        },
      },
    );
    assert.equal(result.route, "semantic");
    assert.deepEqual(result.results.map((item) => item.path), [
      "src/Feature.cs",
      "docs/design.md",
    ]);
    assert.deepEqual(result.results.map((item) => item.matchKind), [
      "semantic",
      "semantic",
    ]);
    assert.equal(result.stale, false);
    assert.equal(result.queryExpansion.used, false);
    assert.equal(result.queryExpansion.identifierQuery, null);
    assert.equal(queryEmbeddingAttempts, 2);

    // A scope narrows the vector query itself, so code cannot crowd documents
    // out of the nearest-neighbour window.
    const scopedSources: Array<string | undefined> = [];
    const scoped = await searchSemantic(
      { projectPath: root, query: "where is storage?", scope: "documents", maxResults: 5 },
      {
        stateRoot,
        dependencies: {
          createEmbeddingProvider: () => ({ ...embedding, async embedQuery() { return [1, 0]; } }),
          createVectorStore: () => ({
            ...store,
            async search(_name: string, _vector: number[], _limit: number, source?: "code" | "document") {
              scopedSources.push(source);
              return hits.filter((hit) => source === undefined || hit.source === source);
            },
          }),
          createQueryExpander: () => null,
          sleep: async () => {},
        },
      },
    );
    assert.deepEqual(scopedSources, ["document"]);
    assert.deepEqual(scoped.results.map((item) => item.path), ["docs/design.md"]);

    const embeddedQueries: string[] = [];
    let searchCalls = 0;
    const fusedResult = await searchSemantic(
      { projectPath: root, query: "저장소 design", maxResults: 2 },
      {
        stateRoot,
        dependencies: {
          createEmbeddingProvider: () => ({
            ...embedding,
            async embedQuery(text) {
              embeddedQueries.push(text);
              return [1, 0];
            },
          }),
          createVectorStore: () => ({
            ...store,
            async search() {
              searchCalls += 1;
              return searchCalls === 1 ? [hits[0]!] : [hits[2]!];
            },
          }),
          createQueryExpander: () => ({
            model: "fixture-expander",
            async expand() {
              return {
                englishQuery: "storage design",
                codeTerms: ["StorageManager"],
                retrievalQuery: "storage design StorageManager",
              };
            },
          }),
          sleep: async () => {},
        },
      },
    );
    assert.deepEqual(embeddedQueries, [
      "storage design StorageManager",
      "design",
    ]);
    assert.equal(fusedResult.queryExpansion.identifierQuery, "design");
    assert.deepEqual(
      new Set(fusedResult.results.map((item) => item.path)),
      new Set(["src/Feature.cs", "docs/design.md"]),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("searchSemantic validates handoff evidence from the Markdown source", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-context-handoff-search-"));
  const stateRoot = path.join(root, "state");
  const handoffRoot = path.join(root, "handoff-root");
  const handoffProject = path.join(handoffRoot, "fixture-project");
  try {
    await mkdir(path.join(root, "src"));
    await mkdir(handoffProject, { recursive: true });
    await writeProjectConfig(
      root,
      "version: 1\nsources:\n  code: [src]\n  documents: []\n  handoff:\n    enabled: true\n    projectSlug: fixture-project\nservices:\n  ollama:\n    embeddingModel: fixture-embedding\n",
    );
    await writeFile(
      path.join(handoffProject, ".project-path"),
      `${root.replaceAll("\\", "/")}\n`,
      "utf8",
    );
    const content =
      "---\ntitle: Placement analysis\ndate: 2026-07-14\n---\n\n# Analysis\nPortal CSV risk\n";
    const documentPath = path.join(handoffProject, "analysis_placement.md");
    await writeFile(documentPath, content, "utf8");
    const fileHash = createHash("sha256").update(await readFile(documentPath)).digest("hex");
    const config = (await loadProjectConfig(root)).value;
    const identity = deriveProjectIndexIdentity(root, config);
    const virtualPath = "@handoff/fixture-project/analysis_placement.md";
    await saveProjectIndexState(
      identity,
      {
        version: 1,
        chunkerVersion: 3,
        projectRoot: root,
        projectSlug: identity.projectSlug,
        collectionName: identity.collectionName,
        vectorStoreBackend: "local",
        embeddingModel: "fixture-embedding",
        embeddingDimension: 2,
        indexedAt: "2026-07-14T00:00:00.000Z",
        commit: null,
        files: {
          [virtualPath]: { hash: fileHash, source: "document", chunkIds: [] },
        },
      },
      stateRoot,
    );
    const embedding: EmbeddingProvider = {
      model: "fixture-embedding",
      async probeDimension() { return 2; },
      async embedDocuments(texts) { return texts.map(() => [1, 0]); },
      async embedQuery() { return [1, 0]; },
    };
    const hit: VectorSearchHit = {
      id: "d".repeat(64),
      source: "document",
      path: virtualPath,
      lineStart: 1,
      lineEnd: 7,
      content,
      fileHash,
      indexedAt: "2026-07-14T00:00:00.000Z",
      commit: null,
      score: 0.9,
    };
    const store: ProjectContextVectorStore = {
      async hasCollection() { return true; },
      async ensureCollection() {},
      async dropCollection() {},
      async upsert() {},
      async deleteIds() {},
      async search() { return [hit]; },
    };
    const options = {
      stateRoot,
      handoffRoot,
      dependencies: {
        createEmbeddingProvider: () => embedding,
        createVectorStore: () => store,
        createQueryExpander: () => null,
        sleep: async () => {},
      },
    };

    const result = await searchSemantic(
      {
        projectPath: root,
        query: "portal csv risk",
        scope: "documents",
      },
      options,
    );
    assert.equal(result.results[0]?.documentId, "fixture-project/analysis_placement");
    assert.equal(result.results[0]?.title, "Placement analysis");
    assert.equal(result.results[0]?.date, "2026-07-14");
    assert.equal(result.stale, false);

    await writeFile(documentPath, `${content}\nChanged after indexing\n`, "utf8");
    const stale = await searchSemantic(
      {
        projectPath: root,
        query: "portal csv risk",
        scope: "documents",
      },
      options,
    );
    assert.equal(stale.results.length, 0);
    assert.equal(stale.staleResultsSkipped, 1);
    assert.equal(stale.stale, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("searchSemantic reuses the main worktree index from a linked worktree", async (t) => {
  if (!(await gitAvailable())) return t.skip("git is unavailable");
  const root = await mkdtemp(path.join(tmpdir(), "project-context-semantic-worktree-"));
  const stateRoot = path.join(root, "state");
  const sharedConfig =
    "version: 1\nsources:\n  code: [src]\n  documents: []\nindex:\n  reuseMainWorktree: true\nservices:\n  ollama:\n    embeddingModel: fixture-embedding\n";
  try {
    const { mainRoot, worktreeRoot, mainCommit, worktreeCommit } =
      await createLinkedWorktree(
        root,
        {
          ".project-context/config.yml": sharedConfig,
          "src/feature.ts": "export const feature = 1;\n",
        },
        {
          worktreeFiles: {
            "src/branch-only.ts": "export const branchOnly = 1;\n",
          },
        },
      );
    assert.notEqual(mainCommit, worktreeCommit);
    const source = await readFile(path.join(worktreeRoot, "src", "feature.ts"));
    const fileHash = createHash("sha256").update(source).digest("hex");
    const config = (await loadProjectConfig(mainRoot)).value;
    const identity = deriveProjectIndexIdentity(mainRoot, config);
    await saveProjectIndexState(
      identity,
      {
        version: 1,
        chunkerVersion: 3,
        projectRoot: mainRoot,
        projectSlug: identity.projectSlug,
        collectionName: identity.collectionName,
        vectorStoreBackend: "local",
        embeddingModel: "fixture-embedding",
        embeddingDimension: 2,
        indexedAt: "2026-07-14T00:00:00.000Z",
        commit: mainCommit,
        files: {
          "src/feature.ts": { hash: fileHash, source: "code", chunkIds: [] },
        },
      },
      stateRoot,
    );
    const embedding: EmbeddingProvider = {
      model: "fixture-embedding",
      async probeDimension() { return 2; },
      async embedDocuments(texts) { return texts.map(() => [1, 0]); },
      async embedQuery() { return [1, 0]; },
    };
    const hit: VectorSearchHit = {
      id: "e".repeat(64),
      source: "code",
      path: "src/feature.ts",
      lineStart: 1,
      lineEnd: 1,
      content: source.toString("utf8"),
      fileHash,
      indexedAt: "2026-07-14T00:00:00.000Z",
      commit: null,
      score: 0.9,
    };
    const store: ProjectContextVectorStore = {
      async hasCollection() { return true; },
      async ensureCollection() {},
      async dropCollection() {},
      async upsert() {},
      async deleteIds() {},
      async search() { return [hit]; },
    };
    const options = {
      stateRoot,
      dependencies: {
        createEmbeddingProvider: () => embedding,
        createVectorStore: () => store,
        createQueryExpander: () => null,
        sleep: async () => {},
      },
    };

    const result = await searchSemantic(
      { projectPath: worktreeRoot, query: "feature", scope: "code" },
      options,
    );
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]?.path, "src/feature.ts");
    assert.equal(result.staleResultsSkipped, 0);
    assert.equal(result.commit, worktreeCommit);
    assert.equal(result.indexCommit, mainCommit);
    assert.equal(result.stale, false);

    // A worktree with no configuration of its own inherits the main worktree's.
    await rm(path.join(worktreeRoot, ".project-context"), {
      recursive: true,
      force: true,
    });
    const inherited = await searchSemantic(
      { projectPath: worktreeRoot, query: "feature", scope: "code" },
      options,
    );
    assert.equal(inherited.results.length, 1);
    assert.equal(inherited.stale, false);

    await writeProjectConfig(
      worktreeRoot,
      sharedConfig.replace("index:\n  reuseMainWorktree: true\n", ""),
    );
    await assert.rejects(
      searchSemantic(
        { projectPath: worktreeRoot, query: "feature", scope: "code" },
        options,
      ),
      /Semantic index is not initialized/,
    );
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
});
