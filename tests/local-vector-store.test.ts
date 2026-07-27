import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { LocalVectorStore } from "../src/local-vector-store.js";
import { indexProject } from "../src/indexer.js";
import { searchSemantic } from "../src/semantic-search.js";
import type { VectorEntity } from "../src/vector-store.js";
import { writeProjectConfig } from "./project-config-fixture.js";

function entity(id: string, embedding: number[]): VectorEntity {
  return {
    id,
    embedding,
    project: "fixture",
    source: "code",
    path: `src/${id.slice(0, 1)}.ts`,
    lineStart: 1,
    lineEnd: 1,
    content: id,
    fileHash: "f".repeat(64),
    indexedAt: "2026-07-23T00:00:00.000Z",
    commit: "",
  };
}

test("LocalVectorStore persists deterministic cosine results and collection changes", async () => {
  const stateRoot = await mkdtemp(path.join(tmpdir(), "project-context-local-vectors-"));
  const collection = "pc_fixture_v1";
  const a = "a".repeat(64);
  const b = "b".repeat(64);
  const c = "c".repeat(64);
  try {
    const store = new LocalVectorStore(stateRoot);
    await store.ensureCollection(collection, 2);
    await store.upsert(collection, [
      entity(b, [1, 0]),
      entity(a, [1, 0]),
      entity(c, [0, 1]),
    ]);

    const reopened = new LocalVectorStore(stateRoot);
    assert.deepEqual(
      (await reopened.search(collection, [1, 0], 3)).map((hit) => hit.id),
      [a, b, c],
    );
    assert.equal((await reopened.search(collection, [1, 0], 1))[0]?.commit, null);
    await reopened.upsert(collection, [entity(b, [0, 1])]);
    assert.deepEqual(
      (await new LocalVectorStore(stateRoot).search(collection, [1, 0], 3)).map(
        (hit) => hit.id,
      ),
      [a, b, c],
    );
    await reopened.deleteIds(collection, [a]);
    assert.deepEqual(
      (await new LocalVectorStore(stateRoot).search(collection, [1, 0], 3)).map(
        (hit) => hit.id,
      ),
      [b, c],
    );
    await assert.rejects(() => reopened.ensureCollection(collection, 3), /dimension/i);
    await reopened.dropCollection(collection);
    assert.equal(await new LocalVectorStore(stateRoot).hasCollection(collection), false);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("indexProject and searchSemantic use the local vector store by default", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-context-local-default-"));
  const stateRoot = path.join(root, "state");
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeProjectConfig(
      root,
      [
        "version: 1",
        "sources:",
        "  code: [src]",
        "  documents: []",
        "services:",
        "  ollama:",
        "    embeddingModel: fixture-embedding",
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(root, "src", "Feature.cs"),
      "public class Feature { }\n",
      "utf8",
    );
    const embedding = {
      model: "fixture-embedding",
      async probeDimension() { return 2; },
      async embedDocuments(texts: string[]) { return texts.map(() => [1, 0]); },
      async embedQuery() { return [1, 0]; },
    };

    const indexed = await indexProject(root, {
      stateRoot,
      dependencies: {
        createEmbeddingProvider: () => embedding,
        sleep: async () => {},
      },
    });
    const result = await searchSemantic(
      { projectPath: root, query: "local semantic search" },
      {
        stateRoot,
        dependencies: {
          createEmbeddingProvider: () => embedding,
          createQueryExpander: () => null,
          sleep: async () => {},
        },
      },
    );

    assert.equal(indexed.chunksUpserted > 0, true);
    assert.equal(result.results[0]?.path, "src/Feature.cs");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
