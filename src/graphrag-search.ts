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
import { resolvePathInsideProject, resolveProjectRoot } from "./project-path.js";
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
const MAX_SUMMARY_OUTPUT_EDGES = 1_000;

export interface GraphRagMetadata {
  languages: string[];
  seedNodes: number;
  expandedNodes: number;
  hops: number;
  staleNodesSkipped: number;
  staleEdgesSkipped: number;
  truncated: boolean;
  summaries?: {
    modules: ProjectSummaryModule[];
    truncated: boolean;
    staleSourcesSkipped: number;
  };
}

/** A semantic response, optionally augmented with verified graph expansion. */
export interface GraphRagSearchResult extends SemanticSearchResult {
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
  const identity = deriveProjectIndexIdentity(project.root, config.value);
  const stateRoot = options.stateRoot ?? DEFAULT_STATE_ROOT;
  const loadedManifest = await dependencies.loadProjectGraph(identity, stateRoot);
  if (!loadedManifest.valid || loadedManifest.value === null) return semanticFallback(semantic, input.maxResults);
  const manifest = loadedManifest.value;
  if (
    manifest.projectRoot !== project.root ||
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
    loadedSummary.value.projectRoot === project.root &&
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
    const freshSummarySources = new Map<string, boolean>();
    let staleSourcesSkipped = 0;
    const readFreshSummarySource = async (source: SummarySourceLocator): Promise<boolean> => {
      const key = sourceKey(source);
      const cached = freshSummarySources.get(key);
      if (cached !== undefined) return cached;
      try {
        if (
          !isAllowedTextFile(source.path) ||
          isExcluded(source.path, config.value.exclude)
        ) throw new Error("summary source is excluded");
        const resolved = await resolvePathInsideProject(project.root, source.path, true);
        const sourceKind = classifySource(resolved.absolutePath, targets);
        if (sourceKind !== "code") throw new Error("summary source is not code");
        const current = await readIndexableFile(project.root, {
          source: sourceKind,
          absolutePath: resolved.absolutePath,
          relativePath: resolved.relativePath,
        });
        const lineCount = current.kind === "ok"
          ? current.text.replace(/\r\n?/g, "\n").split("\n").length
          : 0;
        if (
          current.kind !== "ok" || current.hash !== source.fileHash ||
          source.lineStart > lineCount || source.lineEnd > lineCount
        ) throw new Error("summary source changed");
        freshSummarySources.set(key, true);
        return true;
      } catch {
        freshSummarySources.set(key, false);
        staleSourcesSkipped += 1;
        return false;
      }
    };
    const freshNodeIds = new Set(
      [...freshNodeTexts.entries()]
        .filter(([, text]) => text !== null)
        .map(([id]) => id),
    );
    const directModules: ProjectSummaryModule[] = [];
    let summaryTruncated = summaryPayload.truncated;
    let emittedEdges = 0;
    for (const module of summaryPayload.modules) {
      const selectedNodes: ProjectSummaryModule["nodes"] = [];
      for (const locator of module.nodes) {
        const graphNode = nodes.get(locator.id);
        if (
          !freshNodeIds.has(locator.id) || graphNode === undefined ||
          graphNode.path === null || graphNode.lineStart === null ||
          graphNode.lineEnd === null || graphNode.fileHash === null ||
          !sameSource(locator, {
            path: graphNode.path,
            lineStart: graphNode.lineStart,
            lineEnd: graphNode.lineEnd,
            fileHash: graphNode.fileHash,
          }) ||
          !(await readFreshSummarySource(locator))
        ) continue;
        selectedNodes.push(locator);
      }
      const selectedEdges: ProjectSummaryModule["edges"] = [];
      for (const locator of module.edges) {
        if (emittedEdges >= MAX_SUMMARY_OUTPUT_EDGES) {
          summaryTruncated = true;
          break;
        }
        const graphEdge = edgesById.get(locator.id);
        if (
          !freshEdgeIds.has(locator.id) || graphEdge === undefined ||
          !freshNodeIds.has(locator.fromId) || !freshNodeIds.has(locator.toId) ||
          graphEdge.relation !== locator.relation ||
          graphEdge.fromId !== locator.fromId || graphEdge.toId !== locator.toId ||
          !sameSource(locator.evidence, graphEdge.evidence) ||
          !(await readFreshSummarySource(locator.evidence))
        ) continue;
        selectedEdges.push(locator);
        emittedEdges += 1;
      }
      if (selectedNodes.length === 0 && selectedEdges.length === 0) continue;
      const selectedSourceKeys = new Set([
        ...selectedNodes.map(sourceKey),
        ...selectedEdges.map((edge) => sourceKey(edge.evidence)),
      ]);
      const selectedSources: SummarySourceLocator[] = [];
      for (const source of module.sources) {
        if (selectedSourceKeys.has(sourceKey(source)) && await readFreshSummarySource(source)) {
          selectedSources.push(source);
        }
      }
      directModules.push({
        id: module.id,
        parentId: module.parentId,
        kind: module.kind,
        path: module.path,
        nodes: selectedNodes,
        edges: selectedEdges,
        sources: selectedSources,
      });
    }
    const payloadModules = new Map(summaryPayload.modules.map((module) => [module.id, module]));
    const selectedModules = new Map<string, ProjectSummaryModule>();
    for (const direct of directModules) {
      const chain: ProjectSummaryModule[] = [];
      const visited = new Set<string>();
      let current: ProjectSummaryModule | undefined = direct;
      while (current !== undefined && !visited.has(current.id)) {
        visited.add(current.id);
        chain.push(current);
        current = current.parentId === null ? undefined : payloadModules.get(current.parentId);
      }
      if (chain.length === 0 || (chain.at(-1)?.parentId !== null)) {
        summaryTruncated = true;
        continue;
      }
      chain.reverse();
      const additions = chain.filter((module) => !selectedModules.has(module.id));
      if (selectedModules.size + additions.length > MAX_SUMMARY_OUTPUT_MODULES) {
        summaryTruncated = true;
        continue;
      }
      for (const ancestor of chain) {
        if (ancestor.id === direct.id) {
          selectedModules.set(direct.id, direct);
        } else if (!selectedModules.has(ancestor.id)) {
          selectedModules.set(ancestor.id, {
            id: ancestor.id,
            parentId: ancestor.parentId,
            kind: ancestor.kind,
            path: ancestor.path,
            nodes: [],
            edges: [],
            sources: [],
          });
        }
      }
    }
    const modules = [...selectedModules.values()];
    if (modules.length > 0) {
      summaries = { modules, truncated: summaryTruncated, staleSourcesSkipped };
    }
  }

  return {
    route: "semantic",
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
