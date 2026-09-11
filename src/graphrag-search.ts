import { readIndexableFile } from "./file-collector.js";
import {
  graphEdgeId,
  graphManifestFingerprint,
  loadGraphShard,
  loadProjectGraph,
  type StoredGraphEdge,
  type StoredGraphNode,
} from "./graph-store.js";
import {
  DEFAULT_STATE_ROOT,
  deriveProjectIndexIdentity,
} from "./index-state.js";
import {
  normalizePathForComparison,
  resolveIndexRoot,
  resolvePathInsideProject,
  resolveProjectRoot,
} from "./project-path.js";
import type { EvidenceResult, SemanticSearchResult } from "./result-format.js";
import { searchSemantic } from "./semantic-search.js";
import {
  classifySource,
  isExcluded,
  isAllowedTextFile,
  resolveSourceTargets,
  type SearchScope,
} from "./source-policy.js";
import { loadProjectConfig } from "./config.js";
import {
  loadProjectSummary,
  loadProjectSummaryPayload,
  type ProjectSummaryModule,
  type SummarySourceLocator,
} from "./summary-store.js";

const MAX_SEED_NODES = 64;
const MAX_TRAVERSED_NODES = 400;
const GRAPH_HOPS = 2;
const MAX_NODE_EVIDENCE_LINES = 60;
const MAX_SUMMARY_OUTPUT_MODULES = 64;
const MAX_SUMMARY_NODES_PER_MODULE = 3;
const MAX_SUMMARY_OUTPUT_BYTES = 16 * 1024;

export interface GraphRagSummaryLocator {
  path: string;
  lineStart: number;
  lineEnd: number;
}

/**
 * One hierarchy module the expansion reached. The stored sidecar keeps every
 * node and edge locator with its hashes; a response keeps only counts and the
 * highest-ranked node locators, because the evidence was already re-verified.
 */
export interface GraphRagSummaryModule {
  id: string;
  parentId: string | null;
  kind: ProjectSummaryModule["kind"];
  path: string | null;
  nodeCount: number;
  edgeCount: number;
  nodes: GraphRagSummaryLocator[];
}

export interface GraphRagMetadata {
  languages: string[];
  seedNodes: number;
  expandedNodes: number;
  hops: number;
  staleNodesSkipped: number;
  staleEdgesSkipped: number;
  truncated: boolean;
  summaries?: {
    modules: GraphRagSummaryModule[];
    truncated: boolean;
  };
}

/**
 * A semantic response. Its route is `graphrag` when verified graph expansion
 * ran and `semantic` when the graph snapshot could not be used.
 */
export interface GraphRagSearchResult extends Omit<SemanticSearchResult, "route"> {
  route: "semantic" | "graphrag";
  graph?: GraphRagMetadata;
}

interface GraphRagDependencies {
  searchSemantic: typeof searchSemantic;
  loadProjectGraph: typeof loadProjectGraph;
  loadGraphShard: typeof loadGraphShard;
  loadProjectSummary: typeof loadProjectSummary;
  loadProjectSummaryPayload: typeof loadProjectSummaryPayload;
}

const DEFAULT_DEPENDENCIES: GraphRagDependencies = {
  searchSemantic,
  loadProjectGraph,
  loadGraphShard,
  loadProjectSummary,
  loadProjectSummaryPayload,
};

function pathKey(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function rangesOverlap(
  firstStart: number | null,
  firstEnd: number | null,
  secondStart: number | null,
  secondEnd: number | null,
): boolean {
  if (firstStart === null || firstEnd === null || secondStart === null || secondEnd === null) return true;
  return firstStart <= secondEnd && secondStart <= firstEnd;
}

function baseScore(result: EvidenceResult, rank: number): number {
  return Math.max(0.001, result.score ?? 1 / (60 + rank));
}

function sourceKey(source: SummarySourceLocator): string {
  return `${pathKey(source.path)}:${source.lineStart}:${source.lineEnd}:${source.fileHash}`;
}

function sameSource(
  left: SummarySourceLocator,
  right: SummarySourceLocator,
): boolean {
  return sourceKey(left) === sourceKey(right);
}

function semanticFallback(
  semantic: SemanticSearchResult,
  maxResults: number,
): GraphRagSearchResult {
  const results = semantic.results.slice(0, maxResults);
  return {
    ...semantic,
    results,
    truncated: semantic.truncated || semantic.results.length > results.length,
  };
}

function nodeEvidence(
  node: StoredGraphNode,
  text: string,
): EvidenceResult {
  const lineStart = node.lineStart!;
  const lineEnd = Math.min(node.lineEnd!, lineStart + MAX_NODE_EVIDENCE_LINES - 1);
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  return {
    source: "code",
    path: node.path!,
    matchKind: "content",
    lineStart,
    lineEnd,
    text: lines.slice(lineStart - 1, lineEnd).join("\n").trim().slice(0, 2_000),
    score: null,
    indexedAt: null,
    commit: null,
  };
}

export async function searchGraphRag(
  input: {
    projectPath: string;
    query: string;
    scope: SearchScope;
    maxResults: number;
  },
  options: {
    stateRoot?: string;
    handoffRoot?: string;
    dependencies?: Partial<GraphRagDependencies>;
  } = {},
): Promise<GraphRagSearchResult> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...(options.dependencies ?? {}) };
  const seedLimit = Math.min(200, Math.max(input.maxResults * 4, 32));
  const semantic = await dependencies.searchSemantic(
    {
      projectPath: input.projectPath,
      query: input.query,
      scope: input.scope,
      maxResults: seedLimit,
    },
    {
      ...(options.stateRoot === undefined ? {} : { stateRoot: options.stateRoot }),
      ...(options.handoffRoot === undefined ? {} : { handoffRoot: options.handoffRoot }),
    },
  );
  if (input.scope === "documents") return semanticFallback(semantic, input.maxResults);
  const codeSeeds = semantic.results.filter((result) => result.source === "code");
  if (codeSeeds.length === 0) return semanticFallback(semantic, input.maxResults);

  const project = await resolveProjectRoot(input.projectPath);
  const config = await loadProjectConfig(project.root);
  if (!config.valid) return semanticFallback(semantic, input.maxResults);
  const indexRoot = await resolveIndexRoot(
    project.root,
    config.value.index.reuseMainWorktree,
  );
  const identity = deriveProjectIndexIdentity(indexRoot, config.value);
  const stateRoot = options.stateRoot ?? DEFAULT_STATE_ROOT;
  const loadedManifest = await dependencies.loadProjectGraph(identity, stateRoot);
  if (!loadedManifest.valid || loadedManifest.value === null) return semanticFallback(semantic, input.maxResults);
  const manifest = loadedManifest.value;
  if (
    normalizePathForComparison(manifest.projectRoot) !==
      normalizePathForComparison(indexRoot) ||
    manifest.projectSlug !== identity.projectSlug ||
    manifest.collectionName !== identity.collectionName ||
    manifest.indexedAt !== semantic.indexedAt ||
    manifest.commit !== semantic.indexCommit ||
    manifest.shards.length === 0
  ) {
    return semanticFallback(semantic, input.maxResults);
  }
  let summaryPayload: Awaited<ReturnType<typeof loadProjectSummaryPayload>>["value"] = null;
  const loadedSummary = await dependencies.loadProjectSummary(identity, stateRoot);
  if (
    loadedSummary.valid && loadedSummary.value !== null &&
    normalizePathForComparison(loadedSummary.value.projectRoot) ===
      normalizePathForComparison(indexRoot) &&
    loadedSummary.value.projectSlug === identity.projectSlug &&
    loadedSummary.value.collectionName === identity.collectionName &&
    loadedSummary.value.indexedAt === semantic.indexedAt &&
    loadedSummary.value.commit === semantic.indexCommit &&
    loadedSummary.value.graphFingerprint === graphManifestFingerprint(manifest)
  ) {
    const loadedPayload = await dependencies.loadProjectSummaryPayload(
      identity,
      loadedSummary.value,
      stateRoot,
    );
    if (loadedPayload.valid) summaryPayload = loadedPayload.value;
  }

  const nodes = new Map<string, StoredGraphNode>();
  const nodesByPath = new Map<string, StoredGraphNode[]>();
  const adjacency = new Map<string, Array<{ nodeId: string; edge: StoredGraphEdge; edgeId: string }>>();
  const edgesById = new Map<string, StoredGraphEdge>();
  const languages: string[] = [];
  let staleEdgesSkipped = 0;
  let graphTruncated = false;
  for (const entry of manifest.shards) {
    const loaded = await dependencies.loadGraphShard(identity, entry, stateRoot);
    if (!loaded.valid || loaded.value === null) {
      staleEdgesSkipped += entry.edgeCount;
      continue;
    }
    const shard = loaded.value;
    languages.push(shard.language);
    graphTruncated ||= shard.truncated;
    for (const node of shard.nodes) {
      nodes.set(node.id, node);
      if (node.path !== null) {
        const key = pathKey(node.path);
        const entries = nodesByPath.get(key) ?? [];
        entries.push(node);
        nodesByPath.set(key, entries);
      }
    }
    for (const edge of shard.edges) {
      if (!nodes.has(edge.fromId) || !nodes.has(edge.toId)) {
        staleEdgesSkipped += 1;
        continue;
      }
      const edgeId = graphEdgeId(shard.language, edge);
      const from = adjacency.get(edge.fromId) ?? [];
      from.push({ nodeId: edge.toId, edge, edgeId });
      adjacency.set(edge.fromId, from);
      const to = adjacency.get(edge.toId) ?? [];
      to.push({ nodeId: edge.fromId, edge, edgeId });
      adjacency.set(edge.toId, to);
      edgesById.set(edgeId, edge);
    }
  }
  if (nodes.size === 0) return semanticFallback(semantic, input.maxResults);

  const targets = await resolveSourceTargets(project.root, config.value, "code");
  const freshNodeTexts = new Map<string, string | null>();
  const freshEdgeEvidence = new Map<string, boolean>();
  const freshEdgeIds = new Set<string>();
  let staleNodesSkipped = 0;
  const readFreshNode = async (node: StoredGraphNode): Promise<string | null> => {
    const cached = freshNodeTexts.get(node.id);
    if (cached !== undefined) return cached;
    if (
      node.path === null || node.fileHash === null || node.lineStart === null || node.lineEnd === null ||
      !isAllowedTextFile(node.path) || isExcluded(node.path, config.value.exclude)
    ) {
      freshNodeTexts.set(node.id, null);
      staleNodesSkipped += 1;
      return null;
    }
    try {
      const resolved = await resolvePathInsideProject(project.root, node.path, true);
      const source = classifySource(resolved.absolutePath, targets);
      if (source !== "code") throw new Error("source is not code");
      const current = await readIndexableFile(project.root, {
        source,
        absolutePath: resolved.absolutePath,
        relativePath: resolved.relativePath,
      });
      const lineCount = current.kind === "ok"
        ? current.text.replace(/\r\n?/g, "\n").split("\n").length
        : 0;
      if (current.kind !== "ok" || current.hash !== node.fileHash || node.lineEnd > lineCount) {
        throw new Error("node source changed");
      }
      freshNodeTexts.set(node.id, current.text);
      return current.text;
    } catch {
      freshNodeTexts.set(node.id, null);
      staleNodesSkipped += 1;
      return null;
    }
  };
  const readFreshEdge = async (edge: StoredGraphEdge): Promise<boolean> => {
    const evidence = edge.evidence;
    const cacheKey = `${pathKey(evidence.path)}:${evidence.fileHash}:${evidence.lineEnd}`;
    const cached = freshEdgeEvidence.get(cacheKey);
    if (cached !== undefined) return cached;
    try {
      if (isExcluded(evidence.path, config.value.exclude)) throw new Error("edge source is excluded");
      const resolved = await resolvePathInsideProject(project.root, evidence.path, true);
      const source = classifySource(resolved.absolutePath, targets);
      if (source !== "code") throw new Error("edge source is not code");
      const current = await readIndexableFile(project.root, {
        source,
        absolutePath: resolved.absolutePath,
        relativePath: resolved.relativePath,
      });
      const lineCount = current.kind === "ok"
        ? current.text.replace(/\r\n?/g, "\n").split("\n").length
        : 0;
      if (
        current.kind !== "ok" || current.hash !== evidence.fileHash ||
        evidence.lineStart > lineCount || evidence.lineEnd > lineCount
      ) {
        throw new Error("edge source changed");
      }
      freshEdgeEvidence.set(cacheKey, true);
      return true;
    } catch {
      freshEdgeEvidence.set(cacheKey, false);
      staleEdgesSkipped += 1;
      return false;
    }
  };

  const initial = new Map<string, { score: number; hop: number }>();
  for (const [rank, seed] of codeSeeds.slice(0, MAX_SEED_NODES).entries()) {
    if (initial.size >= MAX_SEED_NODES) break;
    for (const node of nodesByPath.get(pathKey(seed.path)) ?? []) {
      if (
        rangesOverlap(node.lineStart, node.lineEnd, seed.lineStart, seed.lineEnd)
      ) {
        const text = await readFreshNode(node);
        if (text === null) continue;
        const score = baseScore(seed, rank + 1);
        const previous = initial.get(node.id);
        if (previous === undefined || score > previous.score) initial.set(node.id, { score, hop: 0 });
      }
    }
  }
  if (initial.size === 0) return semanticFallback(semantic, input.maxResults);

  const traversed = new Map(initial);
  const queue = [...initial.entries()].map(([id, value]) => ({ id, ...value }));
  for (let index = 0; index < queue.length && traversed.size < MAX_TRAVERSED_NODES; index += 1) {
    const current = queue[index]!;
    if (current.hop >= GRAPH_HOPS) continue;
    for (const neighbor of adjacency.get(current.id) ?? []) {
      if (traversed.size >= MAX_TRAVERSED_NODES) break;
      if (!(await readFreshEdge(neighbor.edge))) continue;
      freshEdgeIds.add(neighbor.edgeId);
      const node = nodes.get(neighbor.nodeId);
      if (node === undefined || (await readFreshNode(node)) === null) continue;
      const score = current.score * 0.72;
      const next = { score, hop: current.hop + 1 };
      const previous = traversed.get(neighbor.nodeId);
      if (previous !== undefined && previous.score >= score) continue;
      traversed.set(neighbor.nodeId, next);
      queue.push({ id: neighbor.nodeId, ...next });
    }
  }

  const candidates: Array<{ evidence: EvidenceResult; score: number; key: string }> = semantic.results.map(
    (result, rank) => ({
      evidence: result,
      score: baseScore(result, rank + 1),
      key: `${pathKey(result.path)}:${result.lineStart ?? ""}:${result.lineEnd ?? ""}`,
    }),
  );
  for (const [id, traversal] of traversed) {
    if (traversal.hop === 0) continue;
    const node = nodes.get(id);
    const text = freshNodeTexts.get(id);
    if (node === undefined || text === undefined || text === null) continue;
    const evidence = nodeEvidence(node, text);
    candidates.push({
      evidence: { ...evidence, score: traversal.score },
      score: traversal.score,
      key: `${pathKey(evidence.path)}:${evidence.lineStart}:${evidence.lineEnd}`,
    });
  }
  candidates.sort((left, right) =>
    right.score - left.score ||
    left.evidence.path.localeCompare(right.evidence.path, "en") ||
    (left.evidence.lineStart ?? 0) - (right.evidence.lineStart ?? 0));
  const output: EvidenceResult[] = [];
  const seen = new Set<string>();
  let truncated = semantic.truncated || traversed.size >= MAX_TRAVERSED_NODES;
  for (const candidate of candidates) {
    if (seen.has(candidate.key)) continue;
    seen.add(candidate.key);
    if (output.length >= input.maxResults) {
      truncated = true;
      break;
    }
    output.push(candidate.evidence);
  }

  let summaries: GraphRagMetadata["summaries"];
  if (summaryPayload !== null) {
    // Every node and edge counted here was re-read by readFreshNode or
    // readFreshEdge above; a locator only has to match that verified record.
    const freshNodeIds = new Set(
      [...freshNodeTexts.entries()]
        .filter(([, text]) => text !== null)
        .map(([id]) => id),
    );
    const direct: Array<{ module: GraphRagSummaryModule; score: number }> = [];
    for (const module of summaryPayload.modules) {
      const moduleNodes = module.nodes.filter((locator) => {
        const graphNode = nodes.get(locator.id);
        return freshNodeIds.has(locator.id) && graphNode !== undefined &&
          graphNode.path !== null && graphNode.lineStart !== null &&
          graphNode.lineEnd !== null && graphNode.fileHash !== null &&
          sameSource(locator, {
            path: graphNode.path,
            lineStart: graphNode.lineStart,
            lineEnd: graphNode.lineEnd,
            fileHash: graphNode.fileHash,
          });
      });
      const edgeCount = module.edges.filter((locator) => {
        const graphEdge = edgesById.get(locator.id);
        return freshEdgeIds.has(locator.id) && graphEdge !== undefined &&
          freshNodeIds.has(locator.fromId) && freshNodeIds.has(locator.toId) &&
          graphEdge.relation === locator.relation &&
          graphEdge.fromId === locator.fromId && graphEdge.toId === locator.toId &&
          sameSource(locator.evidence, graphEdge.evidence);
      }).length;
      if (moduleNodes.length === 0 && edgeCount === 0) continue;
      const ranked = moduleNodes
        .map((locator) => ({ locator, score: traversed.get(locator.id)?.score ?? 0 }))
        .sort((left, right) =>
          right.score - left.score ||
          left.locator.path.localeCompare(right.locator.path, "en") ||
          left.locator.lineStart - right.locator.lineStart);
      direct.push({
        score: ranked[0]?.score ?? 0,
        module: {
          id: module.id,
          parentId: module.parentId,
          kind: module.kind,
          path: module.path,
          nodeCount: moduleNodes.length,
          edgeCount,
          nodes: ranked
            .slice(0, Math.min(MAX_SUMMARY_NODES_PER_MODULE, input.maxResults))
            .map(({ locator }) => ({
              path: locator.path,
              lineStart: locator.lineStart,
              lineEnd: locator.lineEnd,
            })),
        },
      });
    }
    // The most relevant modules are placed first, so every bound drops the
    // least relevant ones: at most maxResults reached modules plus their
    // ancestors, within a module and a byte budget.
    direct.sort((left, right) =>
      right.score - left.score ||
      right.module.nodeCount - left.module.nodeCount ||
      left.module.id.localeCompare(right.module.id, "en"));
    const payloadModules = new Map(summaryPayload.modules.map((module) => [module.id, module]));
    const selectedModules = new Map<string, GraphRagSummaryModule>();
    const moduleBytes = (module: GraphRagSummaryModule): number =>
      Buffer.byteLength(JSON.stringify(module), "utf8") + 1;
    let summaryTruncated = summaryPayload.truncated;
    let selectedDirect = 0;
    let bytes = Buffer.byteLength(JSON.stringify({ modules: [], truncated: false }), "utf8");
    for (const { module: reached } of direct) {
      if (selectedDirect >= input.maxResults) {
        summaryTruncated = true;
        break;
      }
      const chain: GraphRagSummaryModule[] = [];
      const visited = new Set<string>();
      let current: ProjectSummaryModule | undefined = payloadModules.get(reached.id);
      while (current !== undefined && !visited.has(current.id)) {
        visited.add(current.id);
        chain.push(current.id === reached.id
          ? reached
          : selectedModules.get(current.id) ?? {
              id: current.id,
              parentId: current.parentId,
              kind: current.kind,
              path: current.path,
              nodeCount: 0,
              edgeCount: 0,
              nodes: [],
            });
        current = current.parentId === null ? undefined : payloadModules.get(current.parentId);
      }
      if (chain.length === 0 || chain.at(-1)?.parentId !== null) {
        summaryTruncated = true;
        continue;
      }
      // An ancestor placeholder added for an earlier module is replaced once
      // that module is reached itself.
      const additions = chain.filter((module) => selectedModules.get(module.id) !== module);
      const addedBytes = additions.reduce((total, module) =>
        total + moduleBytes(module) - (selectedModules.has(module.id) ? moduleBytes(selectedModules.get(module.id)!) : 0), 0);
      const addedModules = additions.filter((module) => !selectedModules.has(module.id)).length;
      if (
        selectedModules.size + addedModules > MAX_SUMMARY_OUTPUT_MODULES ||
        bytes + addedBytes > MAX_SUMMARY_OUTPUT_BYTES
      ) {
        summaryTruncated = true;
        continue;
      }
      for (const module of additions) selectedModules.set(module.id, module);
      bytes += addedBytes;
      selectedDirect += 1;
    }
    const modules = [...selectedModules.values()].sort((left, right) =>
      (left.kind === "project" ? -1 : right.kind === "project" ? 1 : 0) ||
      (left.path ?? "").localeCompare(right.path ?? "", "en") ||
      left.id.localeCompare(right.id, "en"));
    if (modules.length > 0) {
      summaries = { modules, truncated: summaryTruncated };
    }
  }

  return {
    route: "graphrag",
    fallbackUsed: semantic.fallbackUsed,
    query: semantic.query,
    scope: semantic.scope,
    commit: semantic.commit,
    indexCommit: semantic.indexCommit,
    indexedAt: semantic.indexedAt,
    stale: semantic.stale || staleNodesSkipped > 0 || staleEdgesSkipped > 0,
    queryExpansion: semantic.queryExpansion,
    staleResultsSkipped: semantic.staleResultsSkipped + staleNodesSkipped,
    results: output,
    truncated,
    graph: {
      languages: languages.sort((left, right) => left.localeCompare(right, "en")),
      seedNodes: initial.size,
      expandedNodes: [...traversed.values()].filter((entry) => entry.hop > 0).length,
      hops: GRAPH_HOPS,
      staleNodesSkipped,
      staleEdgesSkipped,
      truncated: graphTruncated || traversed.size >= MAX_TRAVERSED_NODES,
      ...(summaries === undefined ? {} : { summaries }),
    },
  };
}
