import path from "node:path";

import { z } from "zod/v4";

import { loadProjectConfig } from "./config.js";
import {
  collectProjectFiles,
  readIndexableFile,
  type CollectedSourceFile,
} from "./file-collector.js";
import {
  resolvePathInsideProject,
  resolveProjectRoot,
} from "./project-path.js";
import {
  classifySource,
  isAllowedTextFile,
  isExcluded,
  resolveSourceTargets,
  type SourceTarget,
} from "./source-policy.js";
import {
  TraceAdapterError,
  type TraceAdapter,
  type TraceAdapterEdge,
  type TraceDiagnostics,
  type TraceDirection,
  type TraceSymbol,
} from "./trace-adapter.js";
import {
  resolveTraceAdapter,
  TraceAdapterLanguageRequiredError,
  TraceAdapterUnavailableError,
} from "./trace-adapter-resolver.js";

export type {
  TraceDirection,
  TraceSymbol as GraphSymbolNode,
  TraceAdapterEvidence as GraphSourceEvidence,
  TraceAdapterEdge as GraphTraceEdge,
  TraceDiagnostics as GraphTraceDiagnostics,
} from "./trace-adapter.js";

export interface GraphTraceResult {
  route: "graph";
  fallbackUsed: false;
  symbol: string;
  direction: TraceDirection;
  commit: string | null;
  analyzedAt: string;
  workerVersion: string;
  stale: boolean;
  staleResultsSkipped: number;
  staleSymbolsSkipped: number;
  matchedSymbols: TraceSymbol[];
  diagnostics: TraceDiagnostics;
  results: TraceAdapterEdge[];
  truncated: boolean;
}

export interface TraceProjectOptions {
  timeoutMs?: number;
  now?: () => Date;
  adapter?: TraceAdapter;
  resolveAdapter?: (selection?: {
    language?: string;
    sourceFileExtensions?: readonly string[];
  }) => Promise<TraceAdapter>;
}

export class GraphTraceError extends Error {
  constructor(
    message: string,
    readonly code:
      | "invalid_config"
      | "invalid_request"
      | "adapter_unavailable"
      | "adapter_failed"
      | "adapter_protocol"
      | "trace_language_required"
      | "symbol_not_found"
      | "ambiguous_symbol",
    readonly candidates: string[] = [],
  ) {
    super(message);
    this.name = "GraphTraceError";
  }
}

const metadataValueSchema = z.union([z.string().max(4_096), z.number().finite(), z.boolean(), z.null()]);
const metadataSchema = z
  .record(z.string().min(1).max(128), metadataValueSchema)
  .refine((value) => Object.keys(value).length <= 32, "Trace adapter metadata has too many entries");

const symbolNodeSchema = z
  .object({
    name: z.string().min(1).max(1_024),
    fullName: z.string().min(1).max(4_096),
    signature: z.string().min(1).max(8_192),
    kind: z.string().min(1).max(128),
    path: z.string().min(1).max(4_096).nullable(),
    lineStart: z.number().int().min(1).nullable(),
    lineEnd: z.number().int().min(1).nullable(),
    fileHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    metadata: metadataSchema.optional(),
  })
  .strict();

const evidenceSchema = z
  .object({
    path: z.string().min(1).max(4_096),
    lineStart: z.number().int().min(1),
    lineEnd: z.number().int().min(1),
    text: z.string().max(2_000),
    fileHash: z.string().regex(/^[a-f0-9]{64}$/),
    metadata: metadataSchema.optional(),
  })
  .strict();

const diagnosticsSchema = z
  .object({
    filesRequested: z.number().int().min(0),
    filesLoaded: z.number().int().min(0),
    filesSkipped: z.number().int().min(0),
    partial: z.boolean(),
    elapsedMs: z.number().int().min(0),
    messages: z.array(z.string().max(4_096)).max(20),
    metadata: metadataSchema.optional(),
  })
  .strict();

const adapterResponseSchema = z
  .object({
    workerVersion: z.string().min(1).max(256),
    symbol: z.string().min(1).max(512),
    direction: z.enum(["callers", "callees", "inherits", "implements"]),
    matchedSymbols: z.array(symbolNodeSchema).max(1_000),
    results: z
      .array(
        z
          .object({
            relation: z.string().min(1).max(128),
            from: symbolNodeSchema,
            to: symbolNodeSchema,
            evidence: evidenceSchema,
            metadata: metadataSchema.optional(),
          })
          .strict(),
      )
      .max(200),
    truncated: z.boolean(),
    diagnostics: diagnosticsSchema,
  })
  .strict();

function pathKey(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  return process.platform === "win32"
    ? normalized.toLocaleLowerCase("en-US")
    : normalized;
}

async function verifyCollectedFiles(
  projectRoot: string,
  files: CollectedSourceFile[],
  targets: SourceTarget[],
  excludes: string[],
): Promise<CollectedSourceFile[]> {
  const verified: CollectedSourceFile[] = [];
  const seen = new Set<string>();
  for (let offset = 0; offset < files.length; offset += 64) {
    const batch = files.slice(offset, offset + 64);
    const resolved = await Promise.all(
      batch.map(async (file) => {
        const checked = await resolvePathInsideProject(
          projectRoot,
          file.relativePath,
          true,
        );
        const source = classifySource(checked.absolutePath, targets);
        if (
          source === null ||
          !isAllowedTextFile(checked.relativePath) ||
          isExcluded(checked.relativePath, excludes)
        ) {
          return null;
        }
        return {
          source,
          absolutePath: checked.absolutePath,
          relativePath: checked.relativePath,
        };
      }),
    );
    for (const file of resolved) {
      if (file === null) continue;
      const key = pathKey(file.relativePath);
      if (seen.has(key)) continue;
      seen.add(key);
      verified.push(file);
    }
  }
  return verified.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath, "en"),
  );
}

function validateNode(
  node: z.infer<typeof symbolNodeSchema>,
  allowedFiles: Map<string, CollectedSourceFile>,
): TraceSymbol {
  const { metadata, ...base } = node;
  if (node.path === null) {
    if (
      node.lineStart !== null ||
      node.lineEnd !== null ||
      node.fileHash !== null
    ) {
      throw new GraphTraceError(
        "Trace adapter returned source lines without a source path",
        "adapter_protocol",
      );
    }
    return {
      ...base,
      ...(metadata === undefined ? {} : { metadata }),
    };
  }
  const normalizedPath = node.path.replaceAll("\\", "/");
  if (!allowedFiles.has(pathKey(normalizedPath))) {
    throw new GraphTraceError(
      `Trace adapter returned a source outside the allowed set: ${node.path}`,
      "adapter_protocol",
    );
  }
  if (
    node.lineStart === null ||
    node.lineEnd === null ||
    node.lineEnd < node.lineStart ||
    node.fileHash === null
  ) {
    throw new GraphTraceError(
      "Trace adapter returned invalid symbol source lines",
      "adapter_protocol",
    );
  }
  return {
    ...base,
    path: normalizedPath,
    ...(metadata === undefined ? {} : { metadata }),
  };
}

function normalizeDiagnostics(
  diagnostics: z.infer<typeof diagnosticsSchema>,
): TraceDiagnostics {
  const { metadata, ...base } = diagnostics;
  return {
    ...base,
    ...(metadata === undefined ? {} : { metadata }),
  };
}

function adapterErrorDetails(
  error: unknown,
): { code: TraceAdapterError["code"]; candidates: string[] } | null {
  if (error instanceof TraceAdapterError) {
    return { code: error.code, candidates: error.candidates };
  }
  if (typeof error !== "object" || error === null) return null;
  const value = error as Record<string, unknown>;
  const code = value.code;
  const candidates = Array.isArray(value.candidates)
    ? value.candidates.filter((candidate): candidate is string => typeof candidate === "string")
    : [];
  return code === "unavailable" ||
      code === "failed" ||
      code === "invalid_request" ||
      code === "symbol_not_found" ||
      code === "ambiguous_symbol"
    ? { code, candidates }
    : null;
}

export async function traceProject(
  input: {
    projectPath: string;
    symbol: string;
    direction: TraceDirection;
    maxResults?: number;
    language?: string;
  },
  options: TraceProjectOptions = {},
): Promise<GraphTraceResult> {
  const symbol = input.symbol.trim();
  const maxResults = input.maxResults ?? 50;
  if (!symbol || symbol.length > 512 || symbol.includes("\0")) {
    throw new GraphTraceError("Trace symbol is empty or invalid", "invalid_request");
  }
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 200) {
    throw new GraphTraceError("maxResults must be between 1 and 200", "invalid_request");
  }

  const project = await resolveProjectRoot(input.projectPath);
  const loadedConfig = await loadProjectConfig(project.root);
  if (!loadedConfig.valid) {
    throw new GraphTraceError(
      `Project configuration is invalid: ${loadedConfig.errors.join("; ")}`,
      "invalid_config",
    );
  }
  const targets = await resolveSourceTargets(
    project.root,
    loadedConfig.value,
    "code",
  );
  const collected = await collectProjectFiles(
    project.root,
    targets,
    loadedConfig.value.exclude,
    Math.min(options.timeoutMs ?? 90_000, 30_000),
  );
  let adapter: TraceAdapter;
  try {
    adapter = options.adapter ?? await (options.resolveAdapter ?? resolveTraceAdapter)({
      ...(input.language === undefined ? {} : { language: input.language }),
      sourceFileExtensions: [...new Set(collected.map((file) =>
        path.extname(file.relativePath).toLocaleLowerCase("en-US"),
      ))],
    });
  } catch (error) {
    if (error instanceof TraceAdapterUnavailableError) {
      throw new GraphTraceError(error.message, "adapter_unavailable", error.candidates);
    }
    if (error instanceof TraceAdapterLanguageRequiredError) {
      throw new GraphTraceError(error.message, "trace_language_required", error.candidates);
    }
    throw new GraphTraceError(
      error instanceof Error ? error.message : String(error),
      "adapter_failed",
    );
  }
  const sourceExtensions = new Set(
    adapter.sourceFileExtensions.map((extension) => extension.toLowerCase()),
  );
  const auxiliaryExtensions = new Set(
    (adapter.auxiliaryFileExtensions ?? []).map((extension) => extension.toLowerCase()),
  );
  const relevant = collected.filter((file) => {
    const extension = path.extname(file.relativePath).toLowerCase();
    return sourceExtensions.has(extension) || auxiliaryExtensions.has(extension);
  });
  const verified = await verifyCollectedFiles(
    project.root,
    relevant,
    targets,
    loadedConfig.value.exclude,
  );
  const sourceFiles = verified.filter((file) =>
    sourceExtensions.has(path.extname(file.relativePath).toLowerCase()),
  );
  const auxiliaryFiles = verified.filter((file) =>
    auxiliaryExtensions.has(path.extname(file.relativePath).toLowerCase()),
  );
  if (sourceFiles.length === 0) {
    throw new GraphTraceError(
      `No configured ${adapter.language} source files are available`,
      "invalid_request",
    );
  }

  const request = {
    projectRoot: project.root,
    files: sourceFiles.map((file) => file.relativePath),
    auxiliaryFiles: auxiliaryFiles.map((file) => file.relativePath),
    symbol,
    direction: input.direction,
    maxResults,
  };
  let rawResponse: unknown;
  try {
    rawResponse = await adapter.trace(request);
  } catch (error) {
    const adapterError = adapterErrorDetails(error);
    if (adapterError !== null) {
      const code = adapterError.code === "unavailable"
        ? "adapter_unavailable"
        : adapterError.code === "symbol_not_found" || adapterError.code === "ambiguous_symbol"
          ? adapterError.code
          : adapterError.code === "invalid_request"
            ? "invalid_request"
            : "adapter_failed";
      throw new GraphTraceError(
        error instanceof Error ? error.message : String(error),
        code,
        adapterError.candidates,
      );
    }
    throw new GraphTraceError(
      error instanceof Error ? error.message : String(error),
      "adapter_failed",
    );
  }

  const parsed = adapterResponseSchema.safeParse(rawResponse);
  if (!parsed.success) {
    throw new GraphTraceError(
      `Trace adapter returned an invalid response: ${parsed.error.message}`,
      "adapter_protocol",
    );
  }
  if (parsed.data.symbol !== symbol || parsed.data.direction !== input.direction) {
    throw new GraphTraceError(
      "Trace adapter response does not match the request",
      "adapter_protocol",
    );
  }

  const allowedFiles = new Map(
    sourceFiles.map((file) => [pathKey(file.relativePath), file]),
  );
  const readCache = new Map<string, Awaited<ReturnType<typeof readIndexableFile>>>();
  const readCurrent = async (
    relativePath: string,
  ): Promise<Awaited<ReturnType<typeof readIndexableFile>>> => {
    const key = pathKey(relativePath);
    let current = readCache.get(key);
    if (current !== undefined) return current;
    const sourceFile = allowedFiles.get(key);
    if (sourceFile === undefined) {
      throw new GraphTraceError(
        `Trace adapter returned a source outside the allowed set: ${relativePath}`,
        "adapter_protocol",
      );
    }
    current = await readIndexableFile(project.root, sourceFile);
    readCache.set(key, current);
    return current;
  };
  const isFreshNode = async (node: TraceSymbol): Promise<boolean> => {
    if (node.path === null) return true;
    const current = await readCurrent(node.path);
    if (current.kind !== "ok" || current.hash !== node.fileHash) return false;
    const lineCount = current.text.replace(/\r\n?/g, "\n").split("\n").length;
    if (node.lineEnd === null || node.lineEnd > lineCount) {
      throw new GraphTraceError(
        "Trace adapter returned symbol lines outside the current source",
        "adapter_protocol",
      );
    }
    return true;
  };
  const matchedSymbols: TraceSymbol[] = [];
  let staleSymbolsSkipped = 0;
  for (const rawNode of parsed.data.matchedSymbols) {
    const node = validateNode(rawNode, allowedFiles);
    if (!(await isFreshNode(node))) {
      staleSymbolsSkipped += 1;
      continue;
    }
    matchedSymbols.push(node);
  }
  const results: TraceAdapterEdge[] = [];
  let staleResultsSkipped = 0;

  for (const edge of parsed.data.results) {
    const evidencePath = edge.evidence.path.replaceAll("\\", "/");
    const from = validateNode(edge.from, allowedFiles);
    const to = validateNode(edge.to, allowedFiles);
    const current = await readCurrent(evidencePath);
    if (
      current.kind !== "ok" ||
      current.hash !== edge.evidence.fileHash ||
      !(await isFreshNode(from)) ||
      !(await isFreshNode(to))
    ) {
      staleResultsSkipped += 1;
      continue;
    }
    const lines = current.text.replace(/\r\n?/g, "\n").split("\n");
    if (
      edge.evidence.lineEnd < edge.evidence.lineStart ||
      edge.evidence.lineEnd > lines.length
    ) {
      throw new GraphTraceError(
        "Trace adapter returned evidence lines outside the current source",
        "adapter_protocol",
      );
    }
    const excerptEnd = Math.min(edge.evidence.lineEnd, edge.evidence.lineStart + 19);
    const text = lines
      .slice(edge.evidence.lineStart - 1, excerptEnd)
      .join("\n")
      .trim()
      .slice(0, 2_000);
    const { metadata: evidenceMetadata, ...evidence } = edge.evidence;
    const { metadata, ...edgeBase } = edge;
    results.push({
      ...edgeBase,
      from,
      to,
      evidence: {
        ...evidence,
        path: evidencePath,
        text,
        ...(evidenceMetadata === undefined ? {} : { metadata: evidenceMetadata }),
      },
      ...(metadata === undefined ? {} : { metadata }),
    });
  }

  return {
    route: "graph",
    fallbackUsed: false,
    symbol,
    direction: input.direction,
    commit: project.commit,
    analyzedAt: (options.now ?? (() => new Date()))().toISOString(),
    workerVersion: parsed.data.workerVersion,
    stale: staleResultsSkipped > 0 || staleSymbolsSkipped > 0,
    staleResultsSkipped,
    staleSymbolsSkipped,
    matchedSymbols,
    diagnostics: normalizeDiagnostics(parsed.data.diagnostics),
    results,
    truncated: parsed.data.truncated,
  };
}
