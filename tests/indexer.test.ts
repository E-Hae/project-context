import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { EmbeddingProvider } from "../src/embedding-client.js";
import type {
  CollectedSourceFile,
  IndexableFileRead,
} from "../src/file-collector.js";
import { indexProject } from "../src/indexer.js";
import { writeProjectConfig } from "./project-config-fixture.js";
import type {
  ProjectContextVectorStore,
  VectorEntity,
  VectorSearchHit,
} from "../src/milvus-rest-client.js";

class MemoryVectorStore implements ProjectContextVectorStore {
  exists = false;
  drops = 0;
  failNextUpsert = false;
  rateLimitFailures = 0;
  upsertAttempts = 0;
  readonly entities = new Map<string, VectorEntity>();
  readonly upsertBatches: VectorEntity[][] = [];

  async hasCollection(): Promise<boolean> {
    return this.exists;
  }
  async ensureCollection(): Promise<void> {
    this.exists = true;
  }
  async dropCollection(): Promise<void> {
    this.drops += 1;
    this.exists = false;
    this.entities.clear();
  }
  async upsert(_collection: string, entities: VectorEntity[]): Promise<void> {
    this.upsertAttempts += 1;
    if (this.rateLimitFailures > 0) {
      this.rateLimitFailures -= 1;
      throw new Error(
        "reach the limit of request, please slowdown and retry later: rate limit exceeded[rate=0]",
      );
    }
    if (this.failNextUpsert) {
      this.failNextUpsert = false;
      throw new Error("fixture upsert failure");
    }
    this.upsertBatches.push(entities);
    for (const entity of entities) this.entities.set(entity.id, entity);
  }
  async deleteIds(_collection: string, ids: string[]): Promise<void> {
    for (const id of ids) this.entities.delete(id);
  }
  async search(): Promise<VectorSearchHit[]> {
    return [];
  }
}

let documentEmbeddingAttempts = 0;
let dimensionProbeAttempts = 0;
const embedding: EmbeddingProvider = {
  model: "fixture-embedding",
  async probeDimension() {
    dimensionProbeAttempts += 1;
    if (dimensionProbeAttempts === 1) {
      throw new Error("ECONNRESET");
    }
    return 2;
  },
  async embedDocuments(texts) {
    documentEmbeddingAttempts += 1;
    if (documentEmbeddingAttempts === 1) {
      throw new Error("queue was full");
    }
    return texts.map((text) => [text.length, 1]);
  },
  async embedQuery(text) {
    return [text.length, 1];
  },
};

async function writeProjectFixture(
  root: string,
  files: Array<{ name: string; text: string }>,
): Promise<void> {
  await mkdir(path.join(root, "src"));
  await writeProjectConfig(
    root,
    "version: 1\nsources:\n  code: [src]\n  documents: []\n  handoff:\n    enabled: false\nservices:\n  ollama:\n    embeddingModel: fixture-embedding\n",
  );
  await Promise.all(
    files.map(({ name, text }) => writeFile(path.join(root, "src", name), text, "utf8")),
  );
}

function fixtureFiles(count: number): CollectedSourceFile[] {
  return Array.from({ length: count }, (_, index) => ({
    source: "code" as const,
    absolutePath: `/fixture/${index}.ts`,
    relativePath: `src/${String(index).padStart(2, "0")}.ts`,
  }));
}

function fixtureRead(file: CollectedSourceFile): IndexableFileRead {
  const index = Number(file.relativePath.match(/\d+/)?.[0] ?? 0);
  return {
    kind: "ok",
    hash: index.toString(16).padStart(64, "0"),
    text: `export const file = "${file.relativePath}";\n`,
    byteLength: file.relativePath.length,
    encoding: "utf-8",
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("indexProject bounds file reads to an eight-file rolling window", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-context-prefetch-window-"));
  const stateRoot = path.join(root, "state");
  const files = fixtureFiles(9);
  const reads = files.map(() => deferred<IndexableFileRead>());
  const store = new MemoryVectorStore();
  const started: number[] = [];
  let activeReads = 0;
  let maxActiveReads = 0;
  let firstReadSettled = false;
  let ninthStartedAfterFirstReadSettled = false;
  let resolveInitialWindow!: () => void;
  const initialWindow = new Promise<void>((resolve) => {
    resolveInitialWindow = resolve;
  });
  let resolveNinthStarted!: () => void;
  const ninthStarted = new Promise<void>((resolve) => {
    resolveNinthStarted = resolve;
  });
  try {
    await writeProjectFixture(root, []);
    const indexing = indexProject(root, {
      stateRoot,
      dependencies: {
        collectFiles: async () => files,
        readFile: async (_projectRoot, file) => {
          const index = files.indexOf(file);
          started.push(index);
          activeReads += 1;
          maxActiveReads = Math.max(maxActiveReads, activeReads);
          if (started.length === 8) resolveInitialWindow();
          if (index === 8) {
            ninthStartedAfterFirstReadSettled = firstReadSettled;
            resolveNinthStarted();
          }
          try {
            return await reads[index]!.promise;
          } finally {
            activeReads -= 1;
            if (index === 0) firstReadSettled = true;
          }
        },
        createEmbeddingProvider: () => ({
          model: "fixture-embedding",
          async probeDimension() { return 2; },
          async embedDocuments(texts) { return texts.map((text) => [text.length, 1]); },
          async embedQuery(text) { return [text.length, 1]; },
        }),
        createVectorStore: () => store,
        now: () => new Date("2026-07-14T00:00:00.000Z"),
        sleep: async () => {},
      },
    });

    await initialWindow;
    assert.deepEqual(started, [0, 1, 2, 3, 4, 5, 6, 7]);
    assert.equal(activeReads, 8);
    reads[0]!.resolve(fixtureRead(files[0]!));
    await ninthStarted;
    assert.deepEqual(started, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(ninthStartedAfterFirstReadSettled, true);
    assert.equal(maxActiveReads, 8);

    for (let index = 1; index < files.length; index += 1) {
      reads[index]!.resolve(fixtureRead(files[index]!));
    }
    await indexing;
    assert.equal(maxActiveReads, 8);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("indexProject consumes reverse-completing reads in sorted order", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-context-prefetch-order-"));
  const stateRoot = path.join(root, "state");
  const files = fixtureFiles(5);
  const reads = files.map(() => deferred<IndexableFileRead>());
  const store = new MemoryVectorStore();
  const progress: string[] = [];
  let resolveStarted!: () => void;
  const allStarted = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  try {
    await writeProjectFixture(root, []);
    const indexing = indexProject(root, {
      stateRoot,
      onProgress: (event) => {
        if (event.phase === "index" && event.path !== undefined) progress.push(event.path);
      },
      dependencies: {
        collectFiles: async () => files,
        readFile: async (_projectRoot, file) => {
          const index = files.indexOf(file);
          if (index === files.length - 1) resolveStarted();
          return reads[index]!.promise;
        },
        createEmbeddingProvider: () => ({
          model: "fixture-embedding",
          async probeDimension() { return 2; },
          async embedDocuments(texts) { return texts.map((text) => [text.length, 1]); },
          async embedQuery(text) { return [text.length, 1]; },
        }),
        createVectorStore: () => store,
        now: () => new Date("2026-07-14T00:00:00.000Z"),
        sleep: async () => {},
      },
    });

    await allStarted;
    for (let index = files.length - 1; index >= 0; index -= 1) {
      reads[index]!.resolve(fixtureRead(files[index]!));
    }
    const result = await indexing;
    const expectedPaths = files.map((file) => file.relativePath);
    assert.deepEqual(progress, expectedPaths);
    assert.deepEqual(result.indexedFileSample, expectedPaths);
    assert.deepEqual(
      store.upsertBatches.flat().map((entity) => entity.path),
      expectedPaths,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("indexProject rereads unchanged files without re-embedding or upserting them", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-context-prefetch-incremental-"));
  const stateRoot = path.join(root, "state");
  const files = fixtureFiles(3);
  const store = new MemoryVectorStore();
  let readCount = 0;
  let embeddingCount = 0;
  try {
    await writeProjectFixture(root, []);
    const dependencies = {
      collectFiles: async () => files,
      readFile: async (_projectRoot: string, file: CollectedSourceFile) => {
        readCount += 1;
        return fixtureRead(file);
      },
      createEmbeddingProvider: () => ({
        model: "fixture-embedding",
        async probeDimension() { return 2; },
        async embedDocuments(texts: string[]) {
          embeddingCount += 1;
          return texts.map((text) => [text.length, 1]);
        },
        async embedQuery(text: string) { return [text.length, 1]; },
      }),
      createVectorStore: () => store,
      now: () => new Date("2026-07-14T00:00:00.000Z"),
      sleep: async () => {},
    };

    await indexProject(root, { stateRoot, dependencies });
    const second = await indexProject(root, { stateRoot, dependencies });
    assert.equal(readCount, files.length * 2);
    assert.equal(second.filesUnchanged, files.length);
    assert.equal(embeddingCount, 1);
    assert.equal(store.upsertBatches.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("indexProject throws the earliest prefetched read error after draining reads", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-context-prefetch-errors-"));
  const stateRoot = path.join(root, "state");
  const files = fixtureFiles(10);
  const reads = files.map(() => deferred<IndexableFileRead>());
  const started: number[] = [];
  const progress: string[] = [];
  const store = new MemoryVectorStore();
  let settledReads = 0;
  let embeddingCalls = 0;
  let resolveInitialWindow!: () => void;
  const initialWindow = new Promise<void>((resolve) => {
    resolveInitialWindow = resolve;
  });
  const firstError = new Error("first source-order read failure");
  const laterError = new Error("later source-order read failure");
  try {
    await writeProjectFixture(root, []);
    const indexing = indexProject(root, {
      stateRoot,
      onProgress: (event) => {
        if (event.phase === "index" && event.path !== undefined) progress.push(event.path);
      },
      dependencies: {
        collectFiles: async () => files,
        readFile: async (_projectRoot, file) => {
          const index = files.indexOf(file);
          started.push(index);
          if (started.length === 8) resolveInitialWindow();
          try {
            return await reads[index]!.promise;
          } finally {
            settledReads += 1;
          }
        },
        createEmbeddingProvider: () => ({
          model: "fixture-embedding",
          async probeDimension() { return 2; },
          async embedDocuments(texts) {
            embeddingCalls += 1;
            return texts.map((text) => [text.length, 1]);
          },
          async embedQuery(text) { return [text.length, 1]; },
        }),
        createVectorStore: () => store,
        now: () => new Date("2026-07-14T00:00:00.000Z"),
        sleep: async () => {},
      },
    });

    await initialWindow;
    let indexingSettled = false;
    void indexing.then(
      () => { indexingSettled = true; },
      () => { indexingSettled = true; },
    );
    reads[4]!.reject(laterError);
    reads[0]!.reject(firstError);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(indexingSettled, false);
    assert.deepEqual(started, [0, 1, 2, 3, 4, 5, 6, 7]);
    for (let index = 1; index < 8; index += 1) {
      if (index !== 4) reads[index]!.resolve(fixtureRead(files[index]!));
    }

    await assert.rejects(indexing, (error) => error === firstError);
    assert.equal(settledReads, 8);
    assert.deepEqual(progress, [files[0]!.relativePath]);
    assert.equal(embeddingCalls, 0);
    assert.equal(store.upsertBatches.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("indexProject is incremental and removes vectors for deleted files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-context-indexer-"));
  const stateRoot = path.join(root, "state");
  const store = new MemoryVectorStore();
  try {
    await mkdir(path.join(root, "src"));
    await writeProjectConfig(
      root,
      "version: 1\nsources:\n  code: [src]\n  documents: []\n  handoff:\n    enabled: false\nservices:\n  ollama:\n    embeddingModel: fixture-embedding\n",
    );
    const sourcePath = path.join(root, "src", "Feature.cs");
    await writeFile(sourcePath, "public class Feature {}\n", "utf8");
    const dependencies = {
      createEmbeddingProvider: () => embedding,
      createVectorStore: () => store,
      now: () => new Date("2026-07-14T00:00:00.000Z"),
      sleep: async () => {},
    };
    store.rateLimitFailures = 2;

    const first = await indexProject(root, { stateRoot, dependencies });
    assert.equal(first.filesIndexed, 1);
    assert.equal(first.filesUnchanged, 0);
    assert.equal(first.fallbackDecodedFiles, 0);
    assert.equal(first.chunksUpserted, 1);
    assert.deepEqual(first.indexedFileSample, ["src/Feature.cs"]);
    assert.equal(dimensionProbeAttempts, 2);
    assert.equal(documentEmbeddingAttempts, 2);
    assert.equal(store.upsertAttempts, 3);
    assert.equal(store.entities.size, 1);

    const second = await indexProject(root, { stateRoot, dependencies });
    assert.equal(second.filesIndexed, 0);
    assert.equal(second.filesUnchanged, 1);
    assert.equal(second.chunksUpserted, 0);
    assert.equal(second.rebuiltCollection, false);

    store.failNextUpsert = true;
    await assert.rejects(
      indexProject(root, {
        stateRoot,
        forceRebuild: true,
        dependencies,
      }),
      /fixture upsert failure/,
    );
    assert.equal(store.drops, 1);
    assert.equal(store.entities.size, 0);

    const recovered = await indexProject(root, { stateRoot, dependencies });
    assert.equal(recovered.rebuiltCollection, true);
    assert.equal(recovered.filesIndexed, 1);
    assert.equal(recovered.filesUnchanged, 0);
    assert.equal(recovered.chunksUpserted, 1);
    assert.equal(store.drops, 2);
    assert.equal(store.entities.size, 1);

    await unlink(sourcePath);
    const third = await indexProject(root, { stateRoot, dependencies });
    assert.equal(third.filesDeleted, 1);
    assert.deepEqual(third.deletedFileSample, ["src/Feature.cs"]);
    assert.equal(third.chunksDeleted, 1);
    assert.equal(store.entities.size, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("indexProject excludes semantic-only files and removes their existing vectors", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-context-semantic-exclude-"));
  const stateRoot = path.join(root, "state");
  const store = new MemoryVectorStore();
  const config = (semanticExclude: string) => [
    "version: 1",
    "sources:",
    "  code: [src]",
    "  documents: [docs]",
    semanticExclude,
    "services:",
    "  ollama:",
    "    embeddingModel: fixture-embedding",
    "",
  ].join("\n");
  const dependencies = {
    createEmbeddingProvider: () => ({
      model: "fixture-embedding",
      async probeDimension() { return 2; },
      async embedDocuments(texts: string[]) { return texts.map((text) => [text.length, 1]); },
      async embedQuery(text: string) { return [text.length, 1]; },
    }),
    createVectorStore: () => store,
    now: () => new Date("2026-07-14T00:00:00.000Z"),
    sleep: async () => {},
  };
  try {
    await mkdir(path.join(root, "src"));
    await mkdir(path.join(root, "docs"));
    await writeProjectConfig(root, config(""));
    await writeFile(path.join(root, "src", "Searchable.cs"), "class Searchable {}\n", "utf8");
    await writeFile(path.join(root, "src", "GraphOnly.cs"), "class GraphOnly {}\n", "utf8");
    await writeFile(path.join(root, "docs", "GraphOnly.md"), "# Graph only\n", "utf8");

    await indexProject(root, { stateRoot, dependencies });
    assert.equal(store.entities.size, 3);

    await writeProjectConfig(root, config('  semanticExclude: ["**/GraphOnly.*"]'));
    const filtered = await indexProject(root, { stateRoot, dependencies });

    assert.equal(filtered.filesSeen, 2);
    assert.equal(filtered.filesDeleted, 1);
    assert.equal(filtered.chunksDeleted, 1);
    assert.deepEqual(
      [...store.entities.values()].map((entity) => entity.path),
      ["docs/GraphOnly.md", "src/Searchable.cs"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("indexProject includes registered handoffs and removes deleted handoff vectors", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-context-handoff-index-"));
  const stateRoot = path.join(root, "state");
  const handoffRoot = path.join(root, "handoff-root");
  const handoffProject = path.join(handoffRoot, "fixture-project");
  const store = new MemoryVectorStore();
  try {
    await mkdir(path.join(root, "src"));
    await mkdir(handoffProject, { recursive: true });
    await writeProjectConfig(
      root,
      "version: 1\nsources:\n  code: [src]\n  documents: []\n  handoff:\n    enabled: true\n    projectSlug: fixture-project\nservices:\n  ollama:\n    embeddingModel: fixture-embedding\n",
    );
    await writeFile(
      path.join(root, "src", "Feature.cs"),
      "public class Feature {}\n",
      "utf8",
    );
    await writeFile(
      path.join(handoffProject, ".project-path"),
      `${root.replaceAll("\\", "/")}\n`,
      "utf8",
    );
    const handoffPath = path.join(handoffProject, "analysis_feature.md");
    await writeFile(
      handoffPath,
      "---\ntitle: Feature analysis\ndate: 2026-07-14\n---\n\n# Analysis\nFeature risk\n",
      "utf8",
    );
    const fixtureEmbedding: EmbeddingProvider = {
      model: "fixture-embedding",
      async probeDimension() { return 2; },
      async embedDocuments(texts) { return texts.map((text) => [text.length, 1]); },
      async embedQuery(text) { return [text.length, 1]; },
    };
    const dependencies = {
      createEmbeddingProvider: () => fixtureEmbedding,
      createVectorStore: () => store,
      now: () => new Date("2026-07-14T00:00:00.000Z"),
      sleep: async () => {},
    };

    const first = await indexProject(root, {
      stateRoot,
      handoffRoot,
      dependencies,
    });
    assert.equal(first.filesSeen, 2);
    assert.equal(first.filesIndexed, 2);
    const handoffEntity = [...store.entities.values()].find((entity) =>
      entity.path.startsWith("@handoff/"),
    );
    assert.equal(
      handoffEntity?.path,
      "@handoff/fixture-project/analysis_feature.md",
    );
    assert.equal(handoffEntity?.source, "document");
    assert.equal(handoffEntity?.commit, "");

    await unlink(handoffPath);
    const second = await indexProject(root, {
      stateRoot,
      handoffRoot,
      dependencies,
    });
    assert.equal(second.filesDeleted, 1);
    assert.deepEqual(second.deletedFileSample, [
      "@handoff/fixture-project/analysis_feature.md",
    ]);
    assert.equal(
      [...store.entities.values()].some((entity) => entity.path.startsWith("@handoff/")),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("indexProject embeds and upserts 65 chunks in batches of 64 and 1", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-context-batch-index-"));
  const stateRoot = path.join(root, "state");
  const store = new MemoryVectorStore();
  const requests: number[] = [];
  let activeEmbeddings = 0;
  let maxActiveEmbeddings = 0;
  let activeUpserts = 0;
  let maxActiveUpserts = 0;
  const originalUpsert = store.upsert.bind(store);
  store.upsert = async (collection, entities) => {
    activeUpserts += 1;
    maxActiveUpserts = Math.max(maxActiveUpserts, activeUpserts);
    await Promise.resolve();
    try {
      await originalUpsert(collection, entities);
    } finally {
      activeUpserts -= 1;
    }
  };
  try {
    await writeProjectFixture(
      root,
      Array.from({ length: 65 }, (_, index) => ({
        name: `Feature${index}.cs`,
        text: `public class Feature${index} {}\n`,
      })),
    );
    const fixtureEmbedding: EmbeddingProvider = {
      model: "fixture-embedding",
      async probeDimension() { return 2; },
      async embedDocuments(texts) {
        requests.push(texts.length);
        activeEmbeddings += 1;
        maxActiveEmbeddings = Math.max(maxActiveEmbeddings, activeEmbeddings);
        await Promise.resolve();
        try {
          return texts.map((text) => [text.length, 1]);
        } finally {
          activeEmbeddings -= 1;
        }
      },
      async embedQuery(text) { return [text.length, 1]; },
    };

    const result = await indexProject(root, {
      stateRoot,
      dependencies: {
        createEmbeddingProvider: () => fixtureEmbedding,
        createVectorStore: () => store,
        now: () => new Date("2026-07-14T00:00:00.000Z"),
        sleep: async () => {},
      },
    });

    assert.equal(result.chunksUpserted, 65);
    assert.deepEqual(requests, [64, 1]);
    assert.deepEqual(store.upsertBatches.map((batch) => batch.length), [64, 1]);
    assert.equal(maxActiveEmbeddings, 1);
    assert.equal(maxActiveUpserts, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("indexProject bisects input-length failures without changing vector order", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-context-split-index-"));
  const stateRoot = path.join(root, "state");
  const store = new MemoryVectorStore();
  const requests: number[] = [];
  try {
    await writeProjectFixture(
      root,
      Array.from({ length: 4 }, (_, index) => ({
        name: `${index}.cs`,
        text: `public class Feature${index} {}\n`,
      })),
    );
    const fixtureEmbedding: EmbeddingProvider = {
      model: "fixture-embedding",
      async probeDimension() { return 2; },
      async embedDocuments(texts) {
        requests.push(texts.length);
        if (texts.length > 1) throw new Error("input length exceeds limit");
        const match = texts[0]!.match(/File: src\/(\d+)\.cs/);
        return [[Number(match?.[1]), 1]];
      },
      async embedQuery(text) { return [text.length, 1]; },
    };

    await indexProject(root, {
      stateRoot,
      dependencies: {
        createEmbeddingProvider: () => fixtureEmbedding,
        createVectorStore: () => store,
        now: () => new Date("2026-07-14T00:00:00.000Z"),
        sleep: async () => {},
      },
    });

    assert.deepEqual(requests, [4, 2, 1, 1, 2, 1, 1]);
    assert.deepEqual(
      store.upsertBatches[0]?.map((entity) => [entity.path, entity.embedding]),
      [
        ["src/0.cs", [0, 1]],
        ["src/1.cs", [1, 1]],
        ["src/2.cs", [2, 1]],
        ["src/3.cs", [3, 1]],
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("indexProject reports context when one embedding input exceeds its length limit", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-context-singleton-index-"));
  const stateRoot = path.join(root, "state");
  try {
    await writeProjectFixture(root, [{ name: "Feature.cs", text: "public class Feature {}\n" }]);
    const fixtureEmbedding: EmbeddingProvider = {
      model: "fixture-embedding",
      async probeDimension() { return 2; },
      async embedDocuments() { throw new Error("input length exceeds limit"); },
      async embedQuery(text) { return [text.length, 1]; },
    };

    await assert.rejects(
      indexProject(root, {
        stateRoot,
        dependencies: {
          createEmbeddingProvider: () => fixtureEmbedding,
          createVectorStore: () => new MemoryVectorStore(),
          now: () => new Date("2026-07-14T00:00:00.000Z"),
          sleep: async () => {},
        },
      }),
      /Embedding failed for src\/Feature\.cs:1-1: input length exceeds limit/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("indexProject does not split non-length embedding failures", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-context-error-index-"));
  const stateRoot = path.join(root, "state");
  const requests: number[] = [];
  try {
    await writeProjectFixture(root, [
      { name: "First.cs", text: "public class First {}\n" },
      { name: "Second.cs", text: "public class Second {}\n" },
    ]);
    const fixtureEmbedding: EmbeddingProvider = {
      model: "fixture-embedding",
      async probeDimension() { return 2; },
      async embedDocuments(texts) {
        requests.push(texts.length);
        throw new Error("fixture embedding failure");
      },
      async embedQuery(text) { return [text.length, 1]; },
    };

    await assert.rejects(
      indexProject(root, {
        stateRoot,
        dependencies: {
          createEmbeddingProvider: () => fixtureEmbedding,
          createVectorStore: () => new MemoryVectorStore(),
          now: () => new Date("2026-07-14T00:00:00.000Z"),
          sleep: async () => {},
        },
      }),
      /fixture embedding failure/,
    );
    assert.deepEqual(requests, [2]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("indexProject reports deterministic phase timings", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-context-timing-index-"));
  const stateRoot = path.join(root, "state");
  const nowValues = [0, 10, 20, 30, 50, 60, 90, 100, 140, 150, 200, 220];
  try {
    await writeProjectFixture(root, [{ name: "Feature.cs", text: "public class Feature {}\n" }]);
    const fixtureEmbedding: EmbeddingProvider = {
      model: "fixture-embedding",
      async probeDimension() { return 2; },
      async embedDocuments(texts) { return texts.map((text) => [text.length, 1]); },
      async embedQuery(text) { return [text.length, 1]; },
    };

    const result = await indexProject(root, {
      stateRoot,
      dependencies: {
        createEmbeddingProvider: () => fixtureEmbedding,
        createVectorStore: () => new MemoryVectorStore(),
        now: () => new Date("2026-07-14T00:00:00.000Z"),
        nowMs: () => nowValues.shift()!,
        sleep: async () => {},
      },
    });

    assert.deepEqual(result.timingsMs, {
      collect: 10,
      prepare: 20,
      index: 30,
      delete: 40,
      saveState: 50,
      total: 220,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
