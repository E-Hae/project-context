import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod/v4";

import { DEFAULT_STATE_ROOT, type ProjectIndexIdentity } from "./index-state.js";
import type {
  TraceAdapterGraphEdge,
  TraceAdapterGraphResponse,
  TraceAdapterMetadata,
  TraceDiagnostics,
  TraceSymbol,
} from "./trace-adapter.js";

export const GRAPH_INDEX_VERSION = 2;
const MAX_GRAPH_SHARD_BYTES = 24 * 1024 * 1024;
const MAX_PROJECT_GRAPH_BYTES = 64 * 1024 * 1024;

export interface StoredGraphNode extends TraceSymbol {
  id: string;
}

export interface StoredGraphEdge {
  relation: string;
  fromId: string;
  toId: string;
  evidence: TraceAdapterGraphEdge["evidence"];
  metadata?: TraceAdapterMetadata;
}

export interface GraphShard {
  version: 2;
  language: string;
  adapter: string;
  workerVersion: string;
  nodes: StoredGraphNode[];
  edges: StoredGraphEdge[];
  diagnostics: TraceDiagnostics;
  truncated: boolean;
}

export interface GraphShardManifestEntry {
  language: string;
  adapter: string;
  workerVersion: string;
  file: string;
  checksum: string;
  nodeCount: number;
  edgeCount: number;
  truncated: boolean;
}

export interface ProjectGraphManifest {
  version: 2;
  projectRoot: string;
  projectSlug: string;
  collectionName: string;
  indexedAt: string;
  commit: string | null;
  shards: GraphShardManifestEntry[];
  diagnostics: string[];
}

export interface LoadedProjectGraph {
  path: string;
  exists: boolean;
  valid: boolean;
  errors: string[];
  value: ProjectGraphManifest | null;
}

export interface LoadedGraphShard {
  path: string;
  exists: boolean;
  valid: boolean;
  errors: string[];
  value: GraphShard | null;
}

const metadataValueSchema = z.union([z.string().max(4_096), z.number().finite(), z.boolean(), z.null()]);
const metadataSchema = z
  .record(z.string().min(1).max(128), metadataValueSchema)
  .refine((value) => Object.keys(value).length <= 32, "Graph metadata has too many entries");
const symbolSchema = z.object({
  name: z.string().min(1).max(1_024),
  fullName: z.string().min(1).max(4_096),
  signature: z.string().min(1).max(8_192),
  kind: z.string().min(1).max(128),
  path: z.string().min(1).max(4_096).nullable(),
  lineStart: z.number().int().min(1).nullable(),
  lineEnd: z.number().int().min(1).nullable(),
  fileHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  metadata: metadataSchema.optional(),
}).strict();
const storedNodeSchema = symbolSchema.extend({ id: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const evidenceSchema = z.object({
  path: z.string().min(1).max(4_096),
  lineStart: z.number().int().min(1),
  lineEnd: z.number().int().min(1),
  fileHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const diagnosticsSchema = z.object({
  filesRequested: z.number().int().min(0),
  filesLoaded: z.number().int().min(0),
  filesSkipped: z.number().int().min(0),
  partial: z.boolean(),
  elapsedMs: z.number().int().min(0),
  messages: z.array(z.string().max(4_096)).max(20),
  metadata: metadataSchema.optional(),
}).strict();
const edgeSchema = z.object({
  relation: z.string().min(1).max(128),
  fromId: z.string().regex(/^[a-f0-9]{64}$/),
  toId: z.string().regex(/^[a-f0-9]{64}$/),
  evidence: evidenceSchema,
  metadata: metadataSchema.optional(),
}).strict();
const shardSchema = z.object({
  version: z.literal(GRAPH_INDEX_VERSION),
  language: z.string().regex(/^[a-z][a-z0-9_-]{0,127}$/),
  adapter: z.string().min(1).max(256),
  workerVersion: z.string().min(1).max(256),
  nodes: z.array(storedNodeSchema).max(20_000),
  edges: z.array(edgeSchema).max(50_000),
  diagnostics: diagnosticsSchema,
  truncated: z.boolean(),
}).strict();
const manifestEntrySchema = z.object({
  language: z.string().regex(/^[a-z][a-z0-9_-]{0,127}$/),
  adapter: z.string().min(1).max(256),
  workerVersion: z.string().min(1).max(256),
  file: z.string().regex(/^[a-z0-9_-]+\.graph\.[a-z][a-z0-9_-]{0,127}(?:\.[a-f0-9]{12}\.[a-f0-9]{12})?\.json$/),
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
  nodeCount: z.number().int().min(0).max(20_000),
  edgeCount: z.number().int().min(0).max(50_000),
  truncated: z.boolean(),
}).strict();
const manifestSchema = z.object({
  version: z.literal(GRAPH_INDEX_VERSION),
  projectRoot: z.string().min(1).max(4_096),
  projectSlug: z.string().min(1).max(128),
  collectionName: z.string().min(1).max(255),
  indexedAt: z.iso.datetime(),
  commit: z.string().max(128).nullable(),
  shards: z.array(manifestEntrySchema).max(32),
  diagnostics: z.array(z.string().max(1_024)).max(100),
}).strict();

function normalizedLanguage(value: string): string {
  const normalized = value.trim().toLocaleLowerCase("en-US");
  if (!/^[a-z][a-z0-9_-]{0,127}$/u.test(normalized)) {
    throw new Error(`Graph adapter returned an invalid language: ${value}`);
  }
  return normalized;
}

export function graphNodeId(language: string, node: TraceSymbol): string {
  return createHash("sha256")
    .update([
      normalizedLanguage(language),
      node.fullName,
      node.signature,
      node.path ?? "",
      String(node.lineStart ?? ""),
      String(node.lineEnd ?? ""),
    ].join("\0"))
    .digest("hex");
}

/** Stable identifier for a stored edge without retaining source text. */
export function graphEdgeId(language: string, edge: StoredGraphEdge): string {
  return createHash("sha256")
    .update([
      normalizedLanguage(language),
      edge.relation,
      edge.fromId,
      edge.toId,
      edge.evidence.path,
      String(edge.evidence.lineStart),
      String(edge.evidence.lineEnd),
      edge.evidence.fileHash,
    ].join("\0"))
    .digest("hex");
}

/**
 * Fingerprints the graph snapshot that a dependent sidecar was built from.
 * The manifest is already canonicalized by saveProjectGraph; sorting shards
 * here makes the guard robust when a valid manifest was written externally.
 */
export function graphManifestFingerprint(manifest: ProjectGraphManifest): string {
  const canonical = {
    version: manifest.version,
    projectRoot: manifest.projectRoot,
    projectSlug: manifest.projectSlug,
    collectionName: manifest.collectionName,
    indexedAt: manifest.indexedAt,
    commit: manifest.commit,
    shards: [...manifest.shards]
      .sort((left, right) =>
        left.language.localeCompare(right.language, "en") ||
        left.adapter.localeCompare(right.adapter, "en") ||
        left.file.localeCompare(right.file, "en")),
    diagnostics: [...manifest.diagnostics],
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function projectGraphManifestPath(
  identity: ProjectIndexIdentity,
  stateRoot = DEFAULT_STATE_ROOT,
): string {
  return path.join(stateRoot, `${identity.stateKey}.graph.json`);
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function graphShardFileName(
  identity: ProjectIndexIdentity,
  language: string,
  adapter: string,
  snapshot: string,
): string {
  return `${identity.stateKey}.graph.${normalizedLanguage(language)}.${shortHash(adapter)}.${snapshot}.json`;
}

async function writeJsonAtomically(target: string, value: unknown): Promise<void> {
  const temporary = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function graphNode(language: string, node: TraceSymbol): StoredGraphNode {
  return { ...node, id: graphNodeId(language, node) };
}

function graphShardSize(shard: unknown): number {
  return Buffer.byteLength(JSON.stringify(shard), "utf8");
}

export function graphShardChecksum(shard: GraphShard): string {
  return createHash("sha256").update(JSON.stringify(shard)).digest("hex");
}

function prefixThatFits<T>(
  values: readonly T[],
  fits: (count: number) => boolean,
): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(middle)) low = middle;
    else high = middle - 1;
  }
  return low;
}

export function createGraphShard(
  language: string,
  adapter: string,
  response: TraceAdapterGraphResponse,
): GraphShard {
  const normalized = normalizedLanguage(language);
  const nodes = new Map<string, StoredGraphNode>();
  let limited = false;
  const addNode = (node: TraceSymbol): string | null => {
    const stored = graphNode(normalized, node);
    const existing = nodes.get(stored.id);
    if (existing !== undefined) return stored.id;
    if (nodes.size >= 20_000) {
      limited = true;
      return null;
    }
    nodes.set(stored.id, stored);
    return stored.id;
  };
  for (const node of response.nodes) addNode(node);
  const edges: StoredGraphEdge[] = [];
  for (const edge of response.results) {
    if (edges.length >= 50_000) {
      limited = true;
      break;
    }
    const fromId = addNode(edge.from);
    const toId = addNode(edge.to);
    if (fromId === null || toId === null) continue;
    edges.push({
      relation: edge.relation,
      fromId,
      toId,
      evidence: edge.evidence,
      ...(edge.metadata === undefined ? {} : { metadata: edge.metadata }),
    });
  }
  const sortedNodes = [...nodes.values()].sort((left, right) => left.id.localeCompare(right.id, "en"));
  const sortedEdges = edges
    .filter((edge, index, all) => all.findIndex((candidate) =>
      candidate.relation === edge.relation && candidate.fromId === edge.fromId &&
      candidate.toId === edge.toId && candidate.evidence.path === edge.evidence.path &&
      candidate.evidence.lineStart === edge.evidence.lineStart,
    ) === index)
    .sort((left, right) =>
      left.fromId.localeCompare(right.fromId, "en") ||
      left.toId.localeCompare(right.toId, "en") ||
      left.relation.localeCompare(right.relation, "en") ||
      left.evidence.path.localeCompare(right.evidence.path, "en") ||
      left.evidence.lineStart - right.evidence.lineStart);
  const makeShard = (
    selectedNodes: StoredGraphNode[],
    selectedEdges: StoredGraphEdge[],
    truncated: boolean,
  ): GraphShard => ({
    version: GRAPH_INDEX_VERSION,
    language: normalized,
    adapter,
    workerVersion: response.workerVersion,
    nodes: selectedNodes,
    edges: selectedEdges,
    diagnostics: response.diagnostics,
    truncated,
  });
  let selectedNodes = sortedNodes;
  let selectedEdges = sortedEdges;
  let shard = makeShard(selectedNodes, selectedEdges, response.truncated || limited);
  if (graphShardSize(shard) > MAX_GRAPH_SHARD_BYTES) {
    limited = true;
    selectedEdges = sortedEdges.slice(0, prefixThatFits(
      sortedEdges,
      (count) => graphShardSize(makeShard(sortedNodes, sortedEdges.slice(0, count), true)) <= MAX_GRAPH_SHARD_BYTES,
    ));
    shard = makeShard(selectedNodes, selectedEdges, true);
    if (graphShardSize(shard) > MAX_GRAPH_SHARD_BYTES) {
      selectedNodes = sortedNodes.slice(0, prefixThatFits(
        sortedNodes,
        (count) => graphShardSize(makeShard(sortedNodes.slice(0, count), [], true)) <= MAX_GRAPH_SHARD_BYTES,
      ));
      const selectedIds = new Set(selectedNodes.map((node) => node.id));
      selectedEdges = selectedEdges.filter((edge) =>
        selectedIds.has(edge.fromId) && selectedIds.has(edge.toId));
      selectedEdges = selectedEdges.slice(0, prefixThatFits(
        selectedEdges,
        (count) => graphShardSize(makeShard(selectedNodes, selectedEdges.slice(0, count), true)) <= MAX_GRAPH_SHARD_BYTES,
      ));
      shard = makeShard(selectedNodes, selectedEdges, true);
    }
  }
  return shardSchema.parse(shard) as GraphShard;
}

export async function saveProjectGraph(
  identity: ProjectIndexIdentity,
  input: Omit<ProjectGraphManifest, "version" | "shards"> & { shards: GraphShard[] },
  stateRoot = DEFAULT_STATE_ROOT,
): Promise<string> {
  await mkdir(stateRoot, { recursive: true });
  const previous = await loadProjectGraph(identity, stateRoot);
  const entries: GraphShardManifestEntry[] = [];
  const snapshot = randomBytes(6).toString("hex");
  const shards = [...input.shards]
    .sort((left, right) =>
      left.language.localeCompare(right.language, "en") || left.adapter.localeCompare(right.adapter, "en"))
    .map((shard) => shardSchema.parse(shard));
  const totalBytes = shards.reduce((total, shard) => total + graphShardSize(shard), 0);
  if (totalBytes > MAX_PROJECT_GRAPH_BYTES) {
    throw new Error("Graph snapshot exceeds the 64 MiB project limit");
  }
  const writtenFiles: string[] = [];
  try {
    for (const parsed of shards) {
      if (graphShardSize(parsed) > MAX_GRAPH_SHARD_BYTES) {
        throw new Error(`Graph shard ${parsed.language}/${parsed.adapter} exceeds 24 MiB`);
      }
      const file = graphShardFileName(identity, parsed.language, parsed.adapter, snapshot);
      await writeJsonAtomically(path.join(stateRoot, file), parsed);
      writtenFiles.push(file);
      entries.push({
        language: parsed.language,
        adapter: parsed.adapter,
        workerVersion: parsed.workerVersion,
        file,
        checksum: graphShardChecksum(parsed as GraphShard),
        nodeCount: parsed.nodes.length,
        edgeCount: parsed.edges.length,
        truncated: parsed.truncated,
      });
    }
    const manifest = manifestSchema.parse({
      version: GRAPH_INDEX_VERSION,
      projectRoot: input.projectRoot,
      projectSlug: input.projectSlug,
      collectionName: input.collectionName,
      indexedAt: input.indexedAt,
      commit: input.commit,
      shards: entries,
      diagnostics: input.diagnostics,
    });
    await writeJsonAtomically(projectGraphManifestPath(identity, stateRoot), manifest);
  } catch (error) {
    await Promise.allSettled(writtenFiles.map((file) => rm(path.join(stateRoot, file), { force: true })));
    throw error;
  }
  if (previous.valid && previous.value !== null) {
    const currentFiles = new Set(entries.map((entry) => entry.file));
    await Promise.allSettled(previous.value.shards
      .filter((entry) => !currentFiles.has(entry.file))
      .map((entry) => rm(path.join(stateRoot, entry.file), { force: true })));
  }
  return projectGraphManifestPath(identity, stateRoot);
}

export async function loadProjectGraph(
  identity: ProjectIndexIdentity,
  stateRoot = DEFAULT_STATE_ROOT,
): Promise<LoadedProjectGraph> {
  const manifestPath = projectGraphManifestPath(identity, stateRoot);
  try {
    const file = await stat(manifestPath);
    if (!file.isFile() || file.size > 2 * 1024 * 1024) {
      return { path: manifestPath, exists: true, valid: false, errors: ["Graph manifest is not a regular file or exceeds 2 MiB"], value: null };
    }
    const parsed = manifestSchema.safeParse(JSON.parse(await readFile(manifestPath, "utf8")));
    if (!parsed.success) {
      return { path: manifestPath, exists: true, valid: false, errors: parsed.error.issues.map((issue) => issue.message), value: null };
    }
    return { path: manifestPath, exists: true, valid: true, errors: [], value: parsed.data as ProjectGraphManifest };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { path: manifestPath, exists: false, valid: true, errors: [], value: null };
    }
    return { path: manifestPath, exists: true, valid: false, errors: [error instanceof Error ? error.message : String(error)], value: null };
  }
}

export async function loadGraphShard(
  identity: ProjectIndexIdentity,
  entry: GraphShardManifestEntry,
  stateRoot = DEFAULT_STATE_ROOT,
): Promise<LoadedGraphShard> {
  const shardPath = path.join(stateRoot, entry.file);
  try {
    const file = await stat(shardPath);
    if (!file.isFile() || file.size > MAX_GRAPH_SHARD_BYTES) {
      return { path: shardPath, exists: true, valid: false, errors: ["Graph shard is not a regular file or exceeds 24 MiB"], value: null };
    }
    const parsed = shardSchema.safeParse(JSON.parse(await readFile(shardPath, "utf8")));
    if (!parsed.success) {
      return { path: shardPath, exists: true, valid: false, errors: parsed.error.issues.map((issue) => issue.message), value: null };
    }
    if (
      parsed.data.language !== entry.language || parsed.data.adapter !== entry.adapter ||
      graphShardChecksum(parsed.data as GraphShard) !== entry.checksum
    ) {
      return { path: shardPath, exists: true, valid: false, errors: ["Graph shard does not match its manifest entry"], value: null };
    }
    return { path: shardPath, exists: true, valid: true, errors: [], value: parsed.data as GraphShard };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { path: shardPath, exists: false, valid: false, errors: ["Graph shard is missing"], value: null };
    }
    return { path: shardPath, exists: true, valid: false, errors: [error instanceof Error ? error.message : String(error)], value: null };
  }
}
