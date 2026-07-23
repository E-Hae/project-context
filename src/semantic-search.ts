import { loadProjectConfig, type ProjectContextConfig } from "./config.js";
import {
  OllamaEmbeddingClient,
  withEmbeddingRetry,
  type EmbeddingProvider,
} from "./embedding-client.js";
import { readIndexableFile } from "./file-collector.js";
import {
  DEFAULT_HANDOFF_ROOT,
  getHandoff,
  parseHandoffVirtualPath,
  type HandoffDocumentMetadata,
} from "./handoff-store.js";
import {
  DEFAULT_STATE_ROOT,
  deriveProjectIndexIdentity,
  isCompatibleIndexState,
  loadProjectIndexState,
} from "./index-state.js";
import {
  MilvusRestClient,
  type ProjectContextVectorStore,
  type VectorSearchHit,
} from "./milvus-rest-client.js";
import { resolvePathInsideProject, resolveProjectRoot } from "./project-path.js";
import {
  OllamaQueryExpander,
  type QueryExpansionProvider,
} from "./query-expander.js";
import type { EvidenceResult, SemanticSearchResult } from "./result-format.js";
import {
  classifySource,
  isAllowedTextFile,
  isExcluded,
  resolveSourceTargets,
  type SearchScope,
} from "./source-policy.js";

interface SemanticSearchDependencies {
  createEmbeddingProvider: (config: ProjectContextConfig) => EmbeddingProvider;
  createVectorStore: (config: ProjectContextConfig) => ProjectContextVectorStore;
  createQueryExpander: (
    config: ProjectContextConfig,
  ) => QueryExpansionProvider | null;
  sleep: (milliseconds: number) => Promise<void>;
}

const DEFAULT_DEPENDENCIES: SemanticSearchDependencies = {
  createEmbeddingProvider: (config) =>
    new OllamaEmbeddingClient(config.services.ollama),
  createVectorStore: (config) => new MilvusRestClient(config.services.milvus),
  createQueryExpander: (config) =>
    config.services.ollama.queryExpansionModel
      ? new OllamaQueryExpander(config.services.ollama)
      : null,
  sleep: (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

function scopeAllows(scope: SearchScope, source: "code" | "document"): boolean {
  return scope === "all" || scope === source || (scope === "documents" && source === "document");
}

function extractIdentifierQuery(query: string): string | null {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const match of query.matchAll(/[A-Za-z_][A-Za-z0-9_.]*/g)) {
    const term = match[0];
    if (term.length < 2) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
    if (terms.length >= 8) break;
  }
  const value = terms.join(" ").slice(0, 512);
  return value || null;
}

interface RankedHit {
  hit: VectorSearchHit;
  score: number;
  sourceIndex: number;
  sourceRank: number;
}

function hitPathKey(hit: VectorSearchHit): string {
  return process.platform === "win32" ? hit.path.toLowerCase() : hit.path;
}

function pathContainsIdentifier(hit: VectorSearchHit, query: string): boolean {
  const candidate = hit.path.toLowerCase();
  return query
    .split(/\s+/)
    .some((term) => term.length >= 2 && candidate.includes(term.toLowerCase()));
}

function fuseHitLists(hitLists: VectorSearchHit[][]): RankedHit[] {
  if (hitLists.length === 1) {
    return hitLists[0]!.map((hit, index) => ({
      hit,
      score: hit.score,
      sourceIndex: 0,
      sourceRank: index + 1,
    }));
  }

  const byPath = new Map<string, RankedHit>();
  for (const [sourceIndex, hits] of hitLists.entries()) {
    const seenPaths = new Set<string>();
    let sourceRank = 0;
    for (const hit of hits) {
      const key = hitPathKey(hit);
      if (seenPaths.has(key)) continue;
      seenPaths.add(key);
      sourceRank += 1;
      const contribution = 1 / (60 + sourceRank);
      const existing = byPath.get(key);
      if (existing === undefined) {
        byPath.set(key, { hit, score: contribution, sourceIndex, sourceRank });
      } else {
        existing.score += contribution;
        if (sourceIndex < existing.sourceIndex) {
          existing.hit = hit;
          existing.sourceIndex = sourceIndex;
          existing.sourceRank = sourceRank;
        }
      }
    }
  }
  return [...byPath.values()].sort(
    (left, right) =>
      right.score - left.score ||
      left.sourceIndex - right.sourceIndex ||
      left.sourceRank - right.sourceRank ||
      left.hit.path.localeCompare(right.hit.path, "en"),
  );
}

export async function searchSemantic(
  input: {
    projectPath: string;
    query: string;
    scope?: SearchScope;
    maxResults?: number;
  },
  options: {
    stateRoot?: string;
    handoffRoot?: string;
    dependencies?: Partial<SemanticSearchDependencies>;
  } = {},
): Promise<SemanticSearchResult> {
  const query = input.query;
  if (!query.trim() || query.length > 2_048 || query.includes("\0")) {
    throw new Error("Semantic query must contain 1 to 2048 valid characters");
  }
  const maxResults = input.maxResults ?? 10;
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 200) {
    throw new Error("maxResults must be an integer between 1 and 200");
  }
  const scope = input.scope ?? "all";
  const dependencies = {
    ...DEFAULT_DEPENDENCIES,
    ...(options.dependencies ?? {}),
  };
  const project = await resolveProjectRoot(input.projectPath);
  const loadedConfig = await loadProjectConfig(project.root);
  if (!loadedConfig.exists) {
    throw new Error(`Project config not found: ${loadedConfig.path}`);
  }
  if (!loadedConfig.valid) {
    throw new Error(`Invalid project config: ${loadedConfig.errors.join("; ")}`);
  }
  const config = loadedConfig.value;
  const identity = deriveProjectIndexIdentity(project.root, config);
  const loadedState = await loadProjectIndexState(
    identity,
    options.stateRoot ?? DEFAULT_STATE_ROOT,
  );
  if (!loadedState.exists) {
    throw new Error("Semantic index is not initialized; run project-context index");
  }
  if (!loadedState.valid || loadedState.value === null) {
    throw new Error(`Semantic index state is invalid: ${loadedState.errors.join("; ")}`);
  }
  const state = loadedState.value;
  if (!isCompatibleIndexState(state, project.root, config, identity)) {
    throw new Error("Semantic index is incompatible with the current configuration; reindex");
  }

  const embedding = dependencies.createEmbeddingProvider(config);
  const vectorStore = dependencies.createVectorStore(config);
  if (!(await vectorStore.hasCollection(identity.collectionName))) {
    throw new Error("Semantic index collection is missing; reindex");
  }
  let retrievalQuery = query;
  const queryExpander = dependencies.createQueryExpander(config);
  const queryExpansion = {
    used: false,
    model: queryExpander?.model ?? null,
    expandedQuery: null as string | null,
    identifierQuery: null as string | null,
    error: null as string | null,
  };
  if (queryExpander !== null && /[^\x00-\x7f]/.test(query)) {
    try {
      const expanded = await queryExpander.expand(query);
      retrievalQuery = expanded.retrievalQuery;
      queryExpansion.used = true;
      queryExpansion.expandedQuery = retrievalQuery;
    } catch (error) {
      queryExpansion.error = error instanceof Error ? error.message : String(error);
    }
  }
  if (/[^\x00-\x7f]/.test(query)) {
    queryExpansion.identifierQuery = extractIdentifierQuery(query);
  }
  const fetchLimit = Math.min(200, Math.max(maxResults * 8, 20));
  const retrievalQueries = [retrievalQuery];
  if (
    queryExpansion.identifierQuery !== null &&
    queryExpansion.identifierQuery.toLowerCase() !== retrievalQuery.toLowerCase()
  ) {
    retrievalQueries.push(queryExpansion.identifierQuery);
  }
  const hitLists: VectorSearchHit[][] = [];
  for (const searchQuery of retrievalQueries) {
    const vector = await withEmbeddingRetry(
      () => embedding.embedQuery(searchQuery),
      dependencies.sleep,
    );
    if (vector.length !== state.embeddingDimension) {
      throw new Error("Embedding dimension changed; reindex the project");
    }
    const searchHits = await vectorStore.search(
      identity.collectionName,
      vector,
      fetchLimit,
    );
    if (searchQuery === queryExpansion.identifierQuery) {
      const identifierHits = searchHits.filter((hit) =>
        pathContainsIdentifier(hit, searchQuery),
      );
      if (identifierHits.length > 0) hitLists.push(identifierHits);
    } else {
      hitLists.push(searchHits);
    }
  }
  const hits = fuseHitLists(hitLists);
  const targets = await resolveSourceTargets(project.root, config, scope);
  const handoffRoot = options.handoffRoot ?? DEFAULT_HANDOFF_ROOT;
  const seenPaths = new Set<string>();
  const results: EvidenceResult[] = [];
  let staleResultsSkipped = 0;
  let hasAdditionalResult = false;

  for (const candidate of hits) {
    const hit = candidate.hit;
    if (!scopeAllows(scope, hit.source)) continue;
    const pathKey =
      process.platform === "win32" ? hit.path.toLowerCase() : hit.path;
    if (seenPaths.has(pathKey)) continue;
    if (!isAllowedTextFile(hit.path) || isExcluded(hit.path, config.exclude)) {
      staleResultsSkipped += 1;
      continue;
    }
    let handoffMetadata: HandoffDocumentMetadata | null = null;
    try {
      const handoffReference = parseHandoffVirtualPath(hit.path);
      if (handoffReference !== null) {
        if (
          !config.sources.handoff.enabled ||
          (config.sources.handoff.projectSlug !== null &&
            config.sources.handoff.projectSlug.toLocaleLowerCase("en-US") !==
              handoffReference.projectSlug.toLocaleLowerCase("en-US"))
        ) {
          staleResultsSkipped += 1;
          continue;
        }
        const document = await getHandoff(
          {
            projectPath: project.root,
            projectSlug: handoffReference.projectSlug,
            label: handoffReference.label,
          },
          { handoffRoot },
        );
        const current = await readIndexableFile(project.root, {
          source: "document",
          absolutePath: document.path,
          relativePath: hit.path,
          boundaryRoot: document.projectFolderPath,
        });
        if (current.kind !== "ok" || current.hash !== hit.fileHash) {
          staleResultsSkipped += 1;
          continue;
        }
        handoffMetadata = document;
      } else {
        const resolved = await resolvePathInsideProject(project.root, hit.path, true);
        const source = classifySource(resolved.absolutePath, targets);
        if (source !== hit.source) {
          staleResultsSkipped += 1;
          continue;
        }
        const current = await readIndexableFile(project.root, {
          source,
          absolutePath: resolved.absolutePath,
          relativePath: resolved.relativePath,
        });
        if (current.kind !== "ok" || current.hash !== hit.fileHash) {
          staleResultsSkipped += 1;
          continue;
        }
      }
    } catch {
      staleResultsSkipped += 1;
      continue;
    }

    seenPaths.add(pathKey);
    if (results.length >= maxResults) {
      hasAdditionalResult = true;
      break;
    }
    results.push({
      source: hit.source,
      path: hit.path,
      ...(handoffMetadata === null
        ? {}
        : {
            documentId: handoffMetadata.documentId,
            title: handoffMetadata.title,
            date: handoffMetadata.date,
          }),
      matchKind: "semantic",
      lineStart: hit.lineStart,
      lineEnd: hit.lineEnd,
      text: hit.content.slice(0, 2_000),
      score: candidate.score,
      indexedAt: hit.indexedAt,
      commit: hit.commit,
    });
  }

  return {
    route: "semantic",
    fallbackUsed: false,
    query,
    scope,
    commit: project.commit,
    indexCommit: state.commit,
    indexedAt: state.indexedAt,
    stale: state.commit !== project.commit || staleResultsSkipped > 0,
    queryExpansion,
    staleResultsSkipped,
    results,
    truncated:
      hasAdditionalResult || hitLists.some((items) => items.length >= fetchLimit),
  };
}
