import path from "node:path";
import { stat } from "node:fs/promises";

import type { ProjectContextConfig } from "./config.js";
import {
  createGraphShard,
  type GraphShard,
} from "./graph-store.js";
import { discoverTraceAdapters } from "./trace-adapter-resolver.js";
import type {
  TraceAdapter,
  TraceAdapterGraphResponse,
  TraceSymbol,
} from "./trace-adapter.js";
import type { CollectedSourceFile } from "./file-collector.js";
import { MAX_INDEX_FILE_BYTES } from "./file-collector.js";

const MAX_GRAPH_NODES = 20_000;
const MAX_GRAPH_EDGES = 50_000;
export const MAX_GRAPH_SOURCE_FILES = 2_000;
export const MAX_GRAPH_AUXILIARY_FILES = 256;
export const MAX_GRAPH_INPUT_BYTES = 64 * 1024 * 1024;

export interface GraphBuildSummary {
  shards: GraphShard[];
  diagnostics: string[];
  adaptersConsidered: number;
  adaptersIndexed: number;
}

export interface GraphIndexerDependencies {
  discoverAdapters: typeof discoverTraceAdapters;
  getFileSize: (file: CollectedSourceFile) => Promise<number | null>;
}

const DEFAULT_DEPENDENCIES: GraphIndexerDependencies = {
  discoverAdapters: discoverTraceAdapters,
  async getFileSize(file) {
    try {
      const fileStat = await stat(file.absolutePath);
      return fileStat.isFile() ? fileStat.size : null;
    } catch {
      return null;
    }
  },
};

function pathKey(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function normalizedPath(value: string): string {
  return value.replaceAll("\\", "/");
}

function sourceFilesFor(adapter: TraceAdapter, files: readonly CollectedSourceFile[]): {
  sourceFiles: CollectedSourceFile[];
  auxiliaryFiles: CollectedSourceFile[];
} {
  const sourceExtensions = new Set(adapter.sourceFileExtensions.map((value) => value.toLocaleLowerCase("en-US")));
  const auxiliaryExtensions = new Set((adapter.auxiliaryFileExtensions ?? [])
    .map((value) => value.toLocaleLowerCase("en-US")));
  const sourceFiles: CollectedSourceFile[] = [];
  const auxiliaryFiles: CollectedSourceFile[] = [];
  for (const file of files) {
    if (file.source !== "code") continue;
    const extension = path.extname(file.relativePath).toLocaleLowerCase("en-US");
    if (sourceExtensions.has(extension)) sourceFiles.push(file);
    else if (auxiliaryExtensions.has(extension)) auxiliaryFiles.push(file);
  }
  const compare = (left: CollectedSourceFile, right: CollectedSourceFile) =>
    left.relativePath.localeCompare(right.relativePath, "en");
  return {
    sourceFiles: sourceFiles.sort(compare),
    auxiliaryFiles: auxiliaryFiles.sort(compare),
  };
}

function validateNode(
  node: TraceSymbol,
  allowed: ReadonlySet<string>,
): TraceSymbol {
  if (node.path === null) {
    if (node.lineStart !== null || node.lineEnd !== null || node.fileHash !== null) {
      throw new Error("Graph adapter returned source fields without a source path");
    }
    return node;
  }
  const normalized = normalizedPath(node.path);
  if (!allowed.has(pathKey(normalized))) {
    throw new Error(`Graph adapter returned a source outside the allowed set: ${node.path}`);
  }
  if (
    node.lineStart === null || node.lineEnd === null || node.lineEnd < node.lineStart ||
    node.fileHash === null
  ) {
    throw new Error("Graph adapter returned invalid symbol source lines");
  }
  return { ...node, path: normalized };
}

function validateGraphResponse(
  response: TraceAdapterGraphResponse,
  allowed: ReadonlySet<string>,
): TraceAdapterGraphResponse {
  const nodes = response.nodes.map((node) => validateNode(node, allowed));
  const results = response.results.map((edge) => {
    const evidencePath = normalizedPath(edge.evidence.path);
    if (!allowed.has(pathKey(evidencePath))) {
      throw new Error(`Graph adapter returned evidence outside the allowed set: ${edge.evidence.path}`);
    }
    if (edge.evidence.lineEnd < edge.evidence.lineStart) {
      throw new Error("Graph adapter returned invalid evidence lines");
    }
    return {
      ...edge,
      from: validateNode(edge.from, allowed),
      to: validateNode(edge.to, allowed),
      evidence: { ...edge.evidence, path: evidencePath },
    };
  });
  return { ...response, nodes, results };
}

async function filterGraphInputBySize(
  files: readonly CollectedSourceFile[],
  getFileSize: GraphIndexerDependencies["getFileSize"],
): Promise<{ files: Array<{ file: CollectedSourceFile; size: number }>; skipped: number }> {
  const sizes = await Promise.all(files.map((file) => getFileSize(file)));
  const selected = files.flatMap((file, index) => {
    const size = sizes[index];
    return size !== undefined && size !== null && size <= MAX_INDEX_FILE_BYTES
      ? [{ file, size }]
      : [];
  });
  return { files: selected, skipped: files.length - selected.length };
}

function limitGraphInputBytes(
  sourceFiles: ReadonlyArray<{ file: CollectedSourceFile; size: number }>,
  auxiliaryFiles: ReadonlyArray<{ file: CollectedSourceFile; size: number }>,
): {
  sourceFiles: CollectedSourceFile[];
  auxiliaryFiles: CollectedSourceFile[];
  sourceSkipped: number;
  auxiliarySkipped: number;
} {
  const selectedSources: CollectedSourceFile[] = [];
  const selectedAuxiliary: CollectedSourceFile[] = [];
  let sourceSkipped = 0;
  let auxiliarySkipped = 0;
  let totalBytes = 0;
  const entries = [
    ...sourceFiles.map((entry) => ({ ...entry, kind: "source" as const })),
    ...auxiliaryFiles.map((entry) => ({ ...entry, kind: "auxiliary" as const })),
  ].sort((left, right) => left.file.relativePath.localeCompare(right.file.relativePath, "en"));
  for (const entry of entries) {
    if (totalBytes + entry.size > MAX_GRAPH_INPUT_BYTES) {
      if (entry.kind === "source") sourceSkipped += 1;
      else auxiliarySkipped += 1;
      continue;
    }
    totalBytes += entry.size;
    if (entry.kind === "source") selectedSources.push(entry.file);
    else selectedAuxiliary.push(entry.file);
  }
  return {
    sourceFiles: selectedSources,
    auxiliaryFiles: selectedAuxiliary,
    sourceSkipped,
    auxiliarySkipped,
  };
}

export async function buildProjectGraph(
  input: {
    projectRoot: string;
    config: ProjectContextConfig;
    files: readonly CollectedSourceFile[];
  },
  options: { dependencies?: Partial<GraphIndexerDependencies> } = {},
): Promise<GraphBuildSummary> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...(options.dependencies ?? {}) };
  const discovery = await dependencies.discoverAdapters();
  const diagnostics = discovery.diagnostics.map((diagnostic) => diagnostic.detail.slice(0, 1_024));
  const shards: GraphShard[] = [];

  for (const adapter of discovery.adapters) {
    if (adapter.buildGraph === undefined) continue;
    const { sourceFiles, auxiliaryFiles } = sourceFilesFor(adapter, input.files);
    if (sourceFiles.length === 0) continue;
    try {
      const sourceCandidates = sourceFiles.slice(0, MAX_GRAPH_SOURCE_FILES);
      const auxiliaryCandidates = auxiliaryFiles.slice(0, MAX_GRAPH_AUXILIARY_FILES);
      const [selectedSources, selectedAuxiliary] = await Promise.all([
        filterGraphInputBySize(sourceCandidates, dependencies.getFileSize),
        filterGraphInputBySize(auxiliaryCandidates, dependencies.getFileSize),
      ]);
      const byteLimited = limitGraphInputBytes(selectedSources.files, selectedAuxiliary.files);
      const sourceInputSkipped =
        sourceFiles.length - sourceCandidates.length + selectedSources.skipped + byteLimited.sourceSkipped;
      const auxiliaryInputSkipped =
        auxiliaryFiles.length - auxiliaryCandidates.length + selectedAuxiliary.skipped + byteLimited.auxiliarySkipped;
      const graphInputSkipped = sourceInputSkipped + auxiliaryInputSkipped;
      if (byteLimited.sourceFiles.length === 0) {
        diagnostics.push(
          `Graph snapshot skipped for ${adapter.name}: no source files within the ${MAX_INDEX_FILE_BYTES}-byte graph input limit`.slice(0, 1_024),
        );
        continue;
      }
      const raw = await adapter.buildGraph({
        projectRoot: input.projectRoot,
        files: byteLimited.sourceFiles.map((file) => file.relativePath),
        auxiliaryFiles: byteLimited.auxiliaryFiles.map((file) => file.relativePath),
        maxNodes: MAX_GRAPH_NODES,
        maxEdges: MAX_GRAPH_EDGES,
        adapterConfig: { unity: input.config.adapters.unity },
      });
      const allowed = new Set(byteLimited.sourceFiles.map((file) => pathKey(file.relativePath)));
      const response = graphInputSkipped > 0
        ? {
            ...raw,
            diagnostics: {
              ...raw.diagnostics,
              filesSkipped: raw.diagnostics.filesSkipped + graphInputSkipped,
              partial: true,
              messages: [
                ...raw.diagnostics.messages.slice(0, 19),
                `Graph input skipped ${sourceInputSkipped} source and ${auxiliaryInputSkipped} auxiliary files (limits: ${MAX_GRAPH_SOURCE_FILES}/${MAX_GRAPH_AUXILIARY_FILES} files, ${MAX_INDEX_FILE_BYTES} bytes per file, ${MAX_GRAPH_INPUT_BYTES} bytes total)`,
              ],
            },
            truncated: true,
          }
        : raw;
      shards.push(createGraphShard(
        adapter.language,
        adapter.name,
        validateGraphResponse(response, allowed),
      ));
    } catch (error) {
      diagnostics.push(
        `Graph snapshot skipped for ${adapter.name}: ${
          error instanceof Error ? error.message : String(error)
        }`.slice(0, 1_024),
      );
    }
  }

  return {
    shards,
    diagnostics: diagnostics.slice(0, 100),
    adaptersConsidered: discovery.adapters.length,
    adaptersIndexed: shards.length,
  };
}
