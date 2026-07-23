import assert from "node:assert/strict";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { DEFAULT_CONFIG } from "../src/config.js";
import {
  acquireProjectIndexLock,
  deriveProjectIndexIdentity,
  loadProjectIndexState,
  saveProjectIndexState,
  type ProjectIndexState,
} from "../src/index-state.js";

test("index state round-trips and lock rejects concurrent writers", async () => {
  const stateRoot = await mkdtemp(path.join(tmpdir(), "project-context-state-"));
  const projectRoot = path.join(stateRoot, "Example Project");
  const identity = deriveProjectIndexIdentity(projectRoot, DEFAULT_CONFIG);
  const state: ProjectIndexState = {
    version: 1,
    chunkerVersion: 3,
    projectRoot,
    projectSlug: identity.projectSlug,
    collectionName: identity.collectionName,
    embeddingModel: DEFAULT_CONFIG.services.ollama.embeddingModel,
    embeddingDimension: 768,
    indexedAt: "2026-07-14T00:00:00.000Z",
    commit: null,
    files: {
      "src/Feature.cs": {
        hash: "a".repeat(64),
        source: "code",
        chunkIds: ["b".repeat(64)],
      },
    },
  };

  try {
    await saveProjectIndexState(identity, state, stateRoot);
    const loaded = await loadProjectIndexState(identity, stateRoot);
    assert.equal(loaded.valid, true);
    assert.deepEqual(loaded.value, state);

    const release = await acquireProjectIndexLock(identity, stateRoot);
    await assert.rejects(
      acquireProjectIndexLock(identity, stateRoot),
      /Another index operation holds lock/,
    );
    await release();
    const releaseAgain = await acquireProjectIndexLock(identity, stateRoot);
    await releaseAgain();

    const staleLock = path.join(stateRoot, `${identity.stateKey}.lock`);
    await writeFile(staleLock, "{}\n", "utf8");
    await utimes(staleLock, new Date(0), new Date(0));
    const releaseAfterStale = await acquireProjectIndexLock(identity, stateRoot);
    await releaseAfterStale();
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});
