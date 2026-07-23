import { createHash } from "node:crypto";

import { chunkDocument, type DocumentChunk } from "./chunker.js";
import { loadProjectConfig, type ProjectContextConfig } from "./config.js";
import {
  OllamaEmbeddingClient,
  withEmbeddingRetry,
  type EmbeddingProvider,
} from "./embedding-client.js";
import {
  collectProjectFiles,
  readIndexableFile,
  type CollectedSourceFile,
} from "./file-collector.js";
import {
  DEFAULT_HANDOFF_ROOT,
  HandoffStoreError,
  handoffVirtualPath,
  listHandoffs,
  parseHandoffVirtualPath,
} from "./handoff-store.js";
import {
  acquireProjectIndexLock,
  CHUNKER_VERSION,
  DEFAULT_STATE_ROOT,
  deriveProjectIndexIdentity,
  isCompatibleIndexState,
  loadProjectIndexState,
  removeProjectIndexState,
  saveProjectIndexState,
  type ProjectIndexFileState,
  type ProjectIndexState,
} from "./index-state.js";
import {
  createVectorStore,
  type ProjectContextVectorStore,
  type VectorEntity,
} from "./vector-store.js";
import { resolveProjectRoot } from "./project-path.js";
import { resolveSourceTargets } from "./source-policy.js";

const EMBEDDING_BATCH_SIZE = 64;
const DELETE_BATCH_SIZE = 200;
const FILE_READ_CONCURRENCY = 8;

export interface IndexProgress {
  phase: "collect" | "index" | "delete" | "done";
  current: number;
  total: number;
  path?: string;
}

export interface IndexSummary {
  projectRoot: string;
  projectSlug: string;
  collectionName: string;
  statePath: string;
  commit: string | null;
  indexedAt: string;
  embeddingModel: string;
  embeddingDimension: number;
  filesSeen: number;
  filesIndexed: number;
  filesUnchanged: number;
  filesDeleted: number;
  filesSkipped: number;
  fallbackDecodedFiles: number;
  indexedFileSample: string[];
  deletedFileSample: string[];
  fallbackDecodedFileSample: string[];
  skippedFiles: Array<{ path: string; reason: string }>;
  chunksUpserted: number;
  chunksDeleted: number;
  rebuiltCollection: boolean;
  timingsMs: {
    collect: number;
    prepare: number;
    index: number;
    delete: number;
    saveState: number;
    total: number;
  };
}

interface PendingChunk {
  file: CollectedSourceFile;
  fileHash: string;
  chunk: DocumentChunk;
  id: string;
}

type FileReadOutcome =
  | { kind: "success"; read: Awaited<ReturnType<typeof readIndexableFile>> }
  | { kind: "failure"; error: unknown };

interface IndexerDependencies {
  collectFiles: typeof collectProjectFiles;
  collectHandoffFiles: (
    projectRoot: string,
    config: ProjectContextConfig,
    handoffRoot: string,
  ) => Promise<CollectedSourceFile[]>;
  readFile: typeof readIndexableFile;
  createEmbeddingProvider: (config: ProjectContextConfig) => EmbeddingProvider;
  createVectorStore: (
    config: ProjectContextConfig,
    stateRoot: string,
  ) => ProjectContextVectorStore;
  now: () => Date;
  nowMs: () => number;
  sleep: (milliseconds: number) => Promise<void>;
}

const DEFAULT_DEPENDENCIES: IndexerDependencies = {
  collectFiles: collectProjectFiles,
  collectHandoffFiles: collectHandoffSourceFiles,
  readFile: readIndexableFile,
  createEmbeddingProvider: (config) =>
    new OllamaEmbeddingClient(config.services.ollama),
  createVectorStore,
  now: () => new Date(),
  nowMs: () => performance.now(),
  sleep: delay,
};

const MILVUS_WRITE_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];

async function withMilvusWriteRetry<T>(
  operation: () => Promise<T>,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const transient = /reach the limit of request|rate limit exceeded|HTTP 429/i.test(
        message,
      );
      const delayMs = MILVUS_WRITE_RETRY_DELAYS_MS[attempt];
      if (!transient || delayMs === undefined) throw error;
      await sleep(delayMs);
    }
  }
}

function chunkId(
  collectionName: string,
  relativePath: string,
  fileHash: string,
  chunk: DocumentChunk,
): string {
  return createHash("sha256")
    .update(
      [
        collectionName,
        relativePath,
        fileHash,
        String(chunk.ordinal),
        String(chunk.lineStart),
        chunk.text,
      ].join("\0"),
    )
    .digest("hex");
}

function embeddingText(chunk: PendingChunk): string {
  return [
    `File: ${chunk.file.relativePath}`,
    `Source: ${chunk.file.source}`,
    `Lines: ${chunk.chunk.lineStart}-${chunk.chunk.lineEnd}`,
    chunk.chunk.text,
  ].join("\n");
}

function elapsedMilliseconds(startedAt: number, finishedAt: number): number {
  return Math.max(0, Math.round(finishedAt - startedAt));
}

function isInputLengthError(error: unknown): boolean {
  return /input length exceeds/i.test(
    error instanceof Error ? error.message : String(error),
  );
}

async function embedBatch(
  batch: PendingChunk[],
  embedding: EmbeddingProvider,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<number[][]> {
  try {
    return await withEmbeddingRetry(
      () => embedding.embedDocuments(batch.map(embeddingText)),
      sleep,
    );
  } catch (error) {
    if (!isInputLengthError(error)) throw error;
    if (batch.length === 1) {
      const item = batch[0]!;
      throw new Error(
        `Embedding failed for ${item.file.relativePath}:${item.chunk.lineStart}-${item.chunk.lineEnd}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const midpoint = Math.ceil(batch.length / 2);
    const left = await embedBatch(batch.slice(0, midpoint), embedding, sleep);
    const right = await embedBatch(batch.slice(midpoint), embedding, sleep);
    return [...left, ...right];
  }
}

function batches<T>(values: T[], size: number): T[][] {
  const output: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    output.push(values.slice(offset, offset + size));
  }
  return output;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function collectHandoffSourceFiles(
  projectRoot: string,
  config: ProjectContextConfig,
  handoffRoot: string,
): Promise<CollectedSourceFile[]> {
  if (!config.sources.handoff.enabled) return [];
  try {
    const result = await listHandoffs(
      {
        projectPath: projectRoot,
        ...(config.sources.handoff.projectSlug === null
          ? {}
          : { projectSlug: config.sources.handoff.projectSlug }),
      },
      { handoffRoot },
    );
    const project = result.projects[0]!;
    return project.documents.map((document) => ({
      source: "document",
      absolutePath: document.path,
      relativePath: handoffVirtualPath(project.projectSlug, document.label),
      boundaryRoot: project.projectFolderPath,
    }));
  } catch (error) {
    if (error instanceof HandoffStoreError && error.code === "not_found") return [];
    throw error;
  }
}

export async function indexProject(
  projectPath: string,
  options: {
    stateRoot?: string;
    handoffRoot?: string;
    timeoutMs?: number;
    forceRebuild?: boolean;
    onProgress?: (progress: IndexProgress) => void;
    dependencies?: Partial<IndexerDependencies>;
  } = {},
): Promise<IndexSummary> {
  const dependencies = {
    ...DEFAULT_DEPENDENCIES,
    ...(options.dependencies ?? {}),
  };
  const stateRoot = options.stateRoot ?? DEFAULT_STATE_ROOT;
  const project = await resolveProjectRoot(projectPath);
  const loadedConfig = await loadProjectConfig(project.root);
  if (!loadedConfig.exists) {
    throw new Error(`Project config not found: ${loadedConfig.path}`);
  }
  if (!loadedConfig.valid) {
    throw new Error(`Invalid project config: ${loadedConfig.errors.join("; ")}`);
  }
  const config = loadedConfig.value;
  const identity = deriveProjectIndexIdentity(project.root, config);
  const releaseLock = await acquireProjectIndexLock(identity, stateRoot);
  const operationStartedAt = dependencies.nowMs();
  const scheduledReads: Array<{
    index: number;
    outcome: Promise<FileReadOutcome>;
  }> = [];

  try {
    const collectStartedAt = dependencies.nowMs();
    options.onProgress?.({ phase: "collect", current: 0, total: 0 });
    const targets = await resolveSourceTargets(project.root, config, "all");
    const projectFiles = await dependencies.collectFiles(
      project.root,
      targets,
      config.exclude,
      options.timeoutMs ?? 30_000,
    );
    const handoffFiles = await dependencies.collectHandoffFiles(
      project.root,
      config,
      options.handoffRoot ?? DEFAULT_HANDOFF_ROOT,
    );
    const files = [...projectFiles, ...handoffFiles].sort((left, right) =>
      left.relativePath.localeCompare(right.relativePath, "en"),
    );
    options.onProgress?.({ phase: "collect", current: files.length, total: files.length });
    const collectMs = elapsedMilliseconds(collectStartedAt, dependencies.nowMs());

    const prepareStartedAt = dependencies.nowMs();
    const embedding = dependencies.createEmbeddingProvider(config);
    const vectorStore = dependencies.createVectorStore(config, stateRoot);
    const dimension = await withEmbeddingRetry(
      () => embedding.probeDimension(),
      dependencies.sleep,
    );
    const loadedState = await loadProjectIndexState(identity, stateRoot);
    const collectionExists = await vectorStore.hasCollection(identity.collectionName);
    const compatibleState =
      !options.forceRebuild &&
      loadedState.valid &&
      loadedState.value !== null &&
      collectionExists &&
      loadedState.value.embeddingDimension === dimension &&
      isCompatibleIndexState(loadedState.value, project.root, config, identity)
        ? loadedState.value
        : null;
    const rebuiltCollection = compatibleState === null;
    if (rebuiltCollection) {
      // Invalidate the old manifest before the collection is replaced. If a
      // rebuild fails, the next run must rebuild again instead of trusting
      // hashes for vectors that no longer exist.
      await removeProjectIndexState(identity, stateRoot);
      if (collectionExists) {
        await vectorStore.dropCollection(identity.collectionName);
      }
    }
    await vectorStore.ensureCollection(identity.collectionName, dimension);
    const prepareMs = elapsedMilliseconds(prepareStartedAt, dependencies.nowMs());

    const previousFiles = compatibleState?.files ?? {};
    const nextFiles: Record<string, ProjectIndexFileState> = {};
    const currentPaths = new Set(files.map((file) => file.relativePath));
    const indexedAt = dependencies.now().toISOString();
    const pending: PendingChunk[] = [];
    let filesIndexed = 0;
    let filesUnchanged = 0;
    let filesSkipped = 0;
    let fallbackDecodedFiles = 0;
    let chunksUpserted = 0;
    const indexedFileSample: string[] = [];
    const skippedFiles: Array<{ path: string; reason: string }> = [];
    const fallbackDecodedFileSample: string[] = [];

    let nextReadIndex = 0;
    const scheduleRead = (index: number): void => {
      const file = files[index]!;
      scheduledReads.push({
        index,
        outcome: Promise.resolve()
          .then(() => dependencies.readFile(project.root, file))
          .then(
            (read) => ({ kind: "success", read }),
            (error) => ({ kind: "failure", error }),
          ),
      });
    };
    const fillReadWindow = (): void => {
      while (
        nextReadIndex < files.length &&
        scheduledReads.length < FILE_READ_CONCURRENCY
      ) {
        scheduleRead(nextReadIndex);
        nextReadIndex += 1;
      }
    };
    fillReadWindow();

    const indexStartedAt = dependencies.nowMs();
    const flush = async (): Promise<void> => {
      if (pending.length === 0) return;
      const batch = pending.splice(0, pending.length);
      const vectors = await embedBatch(batch, embedding, dependencies.sleep);
      if (
        vectors.length !== batch.length ||
        vectors.some((vector) => vector.length !== dimension)
      ) {
        throw new Error("Embedding response does not match the index collection schema");
      }
      const entities: VectorEntity[] = batch.map((item, index) => ({
        id: item.id,
        embedding: vectors[index]!,
        project: identity.projectSlug,
        source: item.file.source,
        path: item.file.relativePath,
        lineStart: item.chunk.lineStart,
        lineEnd: item.chunk.lineEnd,
        content: item.chunk.text,
        fileHash: item.fileHash,
        indexedAt,
        commit:
          parseHandoffVirtualPath(item.file.relativePath) === null
            ? project.commit ?? ""
            : "",
      }));
      await withMilvusWriteRetry(
        () => vectorStore.upsert(identity.collectionName, entities),
        dependencies.sleep,
      );
      chunksUpserted += entities.length;
    };

    for (const [index, file] of files.entries()) {
      options.onProgress?.({
        phase: "index",
        current: index,
        total: files.length,
        path: file.relativePath,
      });
      const scheduled = scheduledReads.shift();
      if (scheduled === undefined || scheduled.index !== index) {
        throw new Error("File read prefetch window is out of order");
      }
      const outcome = await scheduled.outcome;
      if (outcome.kind === "failure") throw outcome.error;
      fillReadWindow();
      const read = outcome.read;
      if (read.kind === "skipped") {
        filesSkipped += 1;
        if (skippedFiles.length < 100) {
          skippedFiles.push({ path: file.relativePath, reason: read.reason });
        }
        continue;
      }
      if (read.encoding !== "utf-8") {
        fallbackDecodedFiles += 1;
        if (fallbackDecodedFileSample.length < 100) {
          fallbackDecodedFileSample.push(file.relativePath);
        }
      }
      const previous = previousFiles[file.relativePath];
      if (
        previous !== undefined &&
        previous.hash === read.hash &&
        previous.source === file.source
      ) {
        nextFiles[file.relativePath] = previous;
        filesUnchanged += 1;
        continue;
      }

      const chunks = chunkDocument({ path: file.relativePath, text: read.text });
      const ids = chunks.map((chunk) =>
        chunkId(identity.collectionName, file.relativePath, read.hash, chunk),
      );
      nextFiles[file.relativePath] = {
        hash: read.hash,
        source: file.source,
        chunkIds: ids,
      };
      filesIndexed += 1;
      if (indexedFileSample.length < 100) indexedFileSample.push(file.relativePath);
      for (const [chunkIndex, chunk] of chunks.entries()) {
        pending.push({ file, fileHash: read.hash, chunk, id: ids[chunkIndex]! });
        if (pending.length >= EMBEDDING_BATCH_SIZE) await flush();
      }
    }
    await flush();
    options.onProgress?.({
      phase: "index",
      current: files.length,
      total: files.length,
    });
    const indexMs = elapsedMilliseconds(indexStartedAt, dependencies.nowMs());

    const deleteStartedAt = dependencies.nowMs();
    const nextIds = new Set(
      Object.values(nextFiles).flatMap((file) => file.chunkIds),
    );
    const staleIds = Object.values(previousFiles)
      .flatMap((file) => file.chunkIds)
      .filter((id) => !nextIds.has(id));
    for (const batch of batches(staleIds, DELETE_BATCH_SIZE)) {
      await vectorStore.deleteIds(identity.collectionName, batch);
    }
    const deletedFiles = Object.keys(previousFiles).filter(
      (relativePath) => !currentPaths.has(relativePath),
    );
    const filesDeleted = deletedFiles.length;
    options.onProgress?.({
      phase: "delete",
      current: staleIds.length,
      total: staleIds.length,
    });
    const deleteMs = elapsedMilliseconds(deleteStartedAt, dependencies.nowMs());

    const state: ProjectIndexState = {
      version: 1,
      chunkerVersion: CHUNKER_VERSION,
      projectRoot: project.root,
      projectSlug: identity.projectSlug,
      collectionName: identity.collectionName,
      vectorStoreBackend: config.services.vectorStore.backend,
      embeddingModel: embedding.model,
      embeddingDimension: dimension,
      indexedAt,
      commit: project.commit,
      files: nextFiles,
    };
    const saveStateStartedAt = dependencies.nowMs();
    const statePath = await saveProjectIndexState(identity, state, stateRoot);
    const saveStateMs = elapsedMilliseconds(
      saveStateStartedAt,
      dependencies.nowMs(),
    );
    options.onProgress?.({ phase: "done", current: files.length, total: files.length });
    return {
      projectRoot: project.root,
      projectSlug: identity.projectSlug,
      collectionName: identity.collectionName,
      statePath,
      commit: project.commit,
      indexedAt,
      embeddingModel: embedding.model,
      embeddingDimension: dimension,
      filesSeen: files.length,
      filesIndexed,
      filesUnchanged,
      filesDeleted,
      filesSkipped,
      fallbackDecodedFiles,
      indexedFileSample,
      deletedFileSample: deletedFiles.slice(0, 100),
      fallbackDecodedFileSample,
      skippedFiles,
      chunksUpserted,
      chunksDeleted: staleIds.length,
      rebuiltCollection,
      timingsMs: {
        collect: collectMs,
        prepare: prepareMs,
        index: indexMs,
        delete: deleteMs,
        saveState: saveStateMs,
        total: elapsedMilliseconds(operationStartedAt, dependencies.nowMs()),
      },
    };
  } finally {
    await Promise.all(scheduledReads.map(({ outcome }) => outcome));
    await releaseLock();
  }
}
