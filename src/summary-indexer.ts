import path from "node:path";

import type { ProjectContextConfig } from "./config.js";
import { graphEdgeId, type GraphShard, type ProjectGraphManifest } from "./graph-store.js";
import type {
  ProjectSummaryModule,
  SummaryEdgeLocator,
  SummaryNodeLocator,
  SummarySourceLocator,
} from "./summary-store.js";
import { MAX_SUMMARY_PAYLOAD_BYTES } from "./summary-store.js";

const MAX_MODULES = 2_048;
const MAX_NODES = 20_000;
const MAX_EDGES = 50_000;

export interface SummaryBuildResult {
  modules: ProjectSummaryModule[];
  diagnostics: string[];
  truncated: boolean;
}

interface ModuleDraft {
  id: string;
  parentId: string | null;
  kind: "project" | "code_root" | "directory";
  path: string | null;
  nodes: SummaryNodeLocator[];
  edges: SummaryEdgeLocator[];
  sources: SummarySourceLocator[];
  sourceKeys: Set<string>;
}

function normalizedPath(value: string): string | null {
  const normalized = value.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  if (!normalized || normalized === ".") return ".";
  if (
    path.posix.isAbsolute(normalized) ||
    normalized.split("/").some((part) => part === ".." || part.length === 0)
  ) return null;
  return normalized;
}

function configuredRoot(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  const wildcard = normalized.search(/[*!?[]/u);
  const prefix = wildcard === -1 ? normalized : normalized.slice(0, wildcard);
  const clean = normalizedPath(prefix.replace(/\/+$/u, ""));
  if (clean === null || clean === ".") return ".";
  return path.posix.extname(clean) ? path.posix.dirname(clean) || "." : clean;
}

function rootContains(root: string, value: string): boolean {
  return root === "." || value === root || value.startsWith(`${root}/`);
}

function parentDirectory(value: string): string {
  const parent = path.posix.dirname(value);
  return parent === "." ? "." : parent;
}

function sourceKey(source: SummarySourceLocator): string {
  return `${source.path}:${source.lineStart}:${source.lineEnd}:${source.fileHash}`;
}

function addSource(module: ModuleDraft, source: SummarySourceLocator): void {
  const locator: SummarySourceLocator = {
    path: source.path,
    lineStart: source.lineStart,
    lineEnd: source.lineEnd,
    fileHash: source.fileHash,
  };
  const key = sourceKey(locator);
  if (module.sourceKeys.has(key)) return;
  module.sourceKeys.add(key);
  module.sources.push(locator);
}

function sourceFromNode(node: GraphShard["nodes"][number]): SummaryNodeLocator | null {
  if (
    node.path === null || node.lineStart === null || node.lineEnd === null || node.fileHash === null ||
    node.lineEnd < node.lineStart
  ) return null;
  const normalized = normalizedPath(node.path);
  if (normalized === null || normalized === ".") return null;
  return {
    id: node.id,
    path: normalized,
    lineStart: node.lineStart,
    lineEnd: node.lineEnd,
    fileHash: node.fileHash,
  };
}

function edgeFromGraph(language: string, edge: GraphShard["edges"][number]): SummaryEdgeLocator | null {
  const evidencePath = normalizedPath(edge.evidence.path);
  if (evidencePath === null || evidencePath === "." || edge.evidence.lineEnd < edge.evidence.lineStart) return null;
  return {
    id: graphEdgeId(language, edge),
    relation: edge.relation,
    fromId: edge.fromId,
    toId: edge.toId,
    evidence: {
      path: evidencePath,
      lineStart: edge.evidence.lineStart,
      lineEnd: edge.evidence.lineEnd,
      fileHash: edge.evidence.fileHash,
    },
  };
}

function comparePath(left: string, right: string): number {
  return left.localeCompare(right, "en");
}

function withDerivedSources(module: Omit<ProjectSummaryModule, "sources">): ProjectSummaryModule {
  const sources = new Map<string, SummarySourceLocator>();
  for (const node of module.nodes) {
    const source = { path: node.path, lineStart: node.lineStart, lineEnd: node.lineEnd, fileHash: node.fileHash };
    sources.set(sourceKey(source), source);
  }
  for (const edge of module.edges) sources.set(sourceKey(edge.evidence), edge.evidence);
  return {
    ...module,
    sources: [...sources.values()].sort((left, right) => sourceKey(left).localeCompare(sourceKey(right), "en")),
  };
}

function pruneToByteBudget(
  modules: readonly ProjectSummaryModule[],
  byteBudget: number,
): { modules: ProjectSummaryModule[]; truncated: boolean } {
  if (Buffer.byteLength(JSON.stringify({ modules }), "utf8") <= byteBudget) {
    return { modules: [...modules], truncated: false };
  }
  const records = modules.flatMap((module, moduleIndex) => [
    ...module.nodes.map((node) => ({ moduleIndex, kind: "node" as const, id: node.id, value: node })),
    ...module.edges.map((edge) => ({ moduleIndex, kind: "edge" as const, id: edge.id, value: edge })),
  ]).sort((left, right) =>
    modules[left.moduleIndex]!.id.localeCompare(modules[right.moduleIndex]!.id, "en") ||
    left.kind.localeCompare(right.kind, "en") || left.id.localeCompare(right.id, "en"));
  const materialize = (count: number): ProjectSummaryModule[] => {
    const output = modules.map((module) => ({
      id: module.id,
      parentId: module.parentId,
      kind: module.kind,
      path: module.path,
      nodes: [] as SummaryNodeLocator[],
      edges: [] as SummaryEdgeLocator[],
    }));
    for (const record of records.slice(0, count)) {
      const module = output[record.moduleIndex]!;
      if (record.kind === "node") module.nodes.push(record.value as SummaryNodeLocator);
      else module.edges.push(record.value as SummaryEdgeLocator);
    }
    return output.map(withDerivedSources);
  };
  let low = 0;
  let high = records.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(JSON.stringify({ modules: materialize(middle) }), "utf8") <= byteBudget) low = middle;
    else high = middle - 1;
  }
  return { modules: materialize(low), truncated: true };
}

/**
 * Builds a deterministic hierarchy of graph locators. It deliberately contains
 * no generated prose or source excerpts, so all later output can be rechecked.
 */
export function buildProjectSummary(input: {
  config: ProjectContextConfig;
  graph: ProjectGraphManifest;
  shards: readonly GraphShard[];
}, options: { byteBudget?: number } = {}): SummaryBuildResult {
  const roots = [...new Set(input.config.sources.code.map(configuredRoot))]
    .sort(comparePath);
  if (roots.length === 0) roots.push(".");
  const nodeById = new Map<string, SummaryNodeLocator>();
  const edgeById = new Map<string, SummaryEdgeLocator>();
  let truncated = input.shards.some((shard) => shard.truncated);
  for (const shard of input.shards) {
    for (const node of shard.nodes) {
      const locator = sourceFromNode(node);
      if (locator !== null && !nodeById.has(locator.id)) nodeById.set(locator.id, locator);
    }
    for (const edge of shard.edges) {
      const locator = edgeFromGraph(shard.language, edge);
      if (locator !== null && !edgeById.has(locator.id)) edgeById.set(locator.id, locator);
    }
  }
  const nodes = [...nodeById.values()].sort((left, right) => left.id.localeCompare(right.id, "en"));
  const edges = [...edgeById.values()].sort((left, right) => left.id.localeCompare(right.id, "en"));
  if (nodes.length > MAX_NODES || edges.length > MAX_EDGES) truncated = true;
  const selectedNodes = nodes.slice(0, MAX_NODES);
  const selectedEdges = edges.slice(0, MAX_EDGES);
  const rootFor = (sourcePath: string): string => {
    const matching = roots.filter((root) => rootContains(root, sourcePath));
    return matching.sort((left, right) => right.length - left.length || comparePath(left, right))[0] ?? ".";
  };

  const directories = new Set<string>();
  const addAncestors = (sourcePath: string): void => {
    const root = rootFor(sourcePath);
    let directory = parentDirectory(sourcePath);
    while (directory !== root && directory !== ".") {
      directories.add(directory);
      directory = parentDirectory(directory);
    }
  };
  for (const node of selectedNodes) addAncestors(node.path);
  for (const edge of selectedEdges) addAncestors(edge.evidence.path);
  const availableDirectorySlots = Math.max(0, MAX_MODULES - 1 - roots.length);
  const selectedDirectories = [...directories]
    .filter((directory) => !roots.includes(directory))
    .sort(comparePath)
    .slice(0, availableDirectorySlots);
  if (directories.size > selectedDirectories.length) truncated = true;
  const directorySet = new Set(selectedDirectories);
  const drafts = new Map<string, ModuleDraft>();
  drafts.set("project", {
    id: "project",
    parentId: null,
    kind: "project",
    path: null,
    nodes: [],
    edges: [],
    sources: [],
    sourceKeys: new Set(),
  });
  const rootId = (root: string) => `root:${root}`;
  const directoryId = (directory: string) => `directory:${directory}`;
  for (const root of roots) {
    const parent = roots
      .filter((candidate) => candidate !== root && rootContains(candidate, root))
      .sort((left, right) => right.length - left.length || comparePath(left, right))[0];
    drafts.set(rootId(root), {
      id: rootId(root),
      parentId: parent === undefined ? "project" : rootId(parent),
      kind: "code_root",
      path: root,
      nodes: [],
      edges: [],
      sources: [],
      sourceKeys: new Set(),
    });
  }
  for (const directory of selectedDirectories) {
    const root = rootFor(directory);
    let parentPath = parentDirectory(directory);
    while (parentPath !== root && !directorySet.has(parentPath) && parentPath !== ".") {
      parentPath = parentDirectory(parentPath);
    }
    drafts.set(directoryId(directory), {
      id: directoryId(directory),
      parentId: parentPath === root ? rootId(root) : directoryId(parentPath),
      kind: "directory",
      path: directory,
      nodes: [],
      edges: [],
      sources: [],
      sourceKeys: new Set(),
    });
  }
  const moduleFor = (sourcePath: string): ModuleDraft => {
    const root = rootFor(sourcePath);
    let directory = parentDirectory(sourcePath);
    while (directory !== root && directory !== ".") {
      const directoryModule = drafts.get(directoryId(directory));
      if (directoryModule !== undefined) return directoryModule;
      directory = parentDirectory(directory);
    }
    return drafts.get(rootId(root))!;
  };
  for (const node of selectedNodes) {
    const module = moduleFor(node.path);
    module.nodes.push(node);
    addSource(module, node);
  }
  for (const edge of selectedEdges) {
    const module = moduleFor(edge.evidence.path);
    module.edges.push(edge);
    addSource(module, edge.evidence);
  }
  const modules = [...drafts.values()]
    .map(({ sourceKeys: _sourceKeys, ...module }) => ({
      ...module,
      nodes: module.nodes.sort((left, right) => left.id.localeCompare(right.id, "en")),
      edges: module.edges.sort((left, right) => left.id.localeCompare(right.id, "en")),
      sources: module.sources.sort((left, right) => sourceKey(left).localeCompare(sourceKey(right), "en")),
    }))
    .sort((left, right) =>
      (left.kind === "project" ? -1 : right.kind === "project" ? 1 : 0) ||
      (left.path ?? "").localeCompare(right.path ?? "", "en") ||
      left.id.localeCompare(right.id, "en"));
  const byteBudget = options.byteBudget ?? MAX_SUMMARY_PAYLOAD_BYTES - (128 * 1024);
  const bounded = pruneToByteBudget(modules, byteBudget);
  truncated ||= bounded.truncated;
  const diagnostics = [
    ...input.graph.diagnostics,
    ...(truncated ? ["Hierarchy summary was deterministically bounded"] : []),
  ].slice(0, 100).map((message) => message.slice(0, 1_024));
  return { modules: bounded.modules, diagnostics, truncated };
}
