import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

export type TraceDirection =
  | "callers"
  | "callees"
  | "inherits"
  | "implements";

export interface GraphSymbolNode {
  name: string;
  fullName: string;
  signature: string;
  kind: string;
  assembly: string;
  path: string | null;
  lineStart: number | null;
  lineEnd: number | null;
  fileHash: string | null;
  unityMessage: boolean;
}

export interface GraphSourceEvidence {
  path: string;
  lineStart: number;
  lineEnd: number;
  text: string;
  fileHash: string;
}

export interface GraphTraceEdge {
  relation: string;
  from: GraphSymbolNode;
  to: GraphSymbolNode;
  evidence: GraphSourceEvidence;
}

export interface GraphTraceDiagnostics {
  filesRequested: number;
  filesLoaded: number;
  filesSkipped: number;
  metadataFailures: number;
  projectFilesRead: number;
  assemblyDefinitionsLoaded: number;
  referencesLoaded: number;
  referenceFailures: number;
  parseErrors: number;
  unresolvedCandidates: number;
  partial: boolean;
  elapsedMs: number;
  messages: string[];
}

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
  matchedSymbols: GraphSymbolNode[];
  diagnostics: GraphTraceDiagnostics;
  results: GraphTraceEdge[];
  truncated: boolean;
}

export interface RoslynWorkerRequest {
  version: 1;
  projectRoot: string;
  files: string[];
  assemblyDefinitions: string[];
  symbol: string;
  direction: TraceDirection;
  maxResults: number;
}

type RunWorker = (
  request: RoslynWorkerRequest,
  workerPath: string,
  timeoutMs: number,
) => Promise<unknown>;

export interface TraceProjectOptions {
  packageRoot?: string;
  timeoutMs?: number;
  now?: () => Date;
  dependencies?: {
    runWorker?: RunWorker;
  };
}

export class GraphTraceError extends Error {
  constructor(
    message: string,
    readonly code:
      | "invalid_config"
      | "invalid_request"
      | "worker_unavailable"
      | "worker_failed"
      | "worker_protocol"
      | "symbol_not_found"
      | "ambiguous_symbol",
    readonly candidates: string[] = [],
  ) {
    super(message);
    this.name = "GraphTraceError";
  }
}

const symbolNodeSchema = z
  .object({
    name: z.string().min(1).max(1_024),
    fullName: z.string().min(1).max(4_096),
    signature: z.string().min(1).max(8_192),
    kind: z.string().min(1).max(128),
    assembly: z.string().min(1).max(1_024),
    path: z.string().min(1).max(4_096).nullable(),
    lineStart: z.number().int().min(1).nullable(),
    lineEnd: z.number().int().min(1).nullable(),
    fileHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    unityMessage: z.boolean(),
  })
  .strict();

const evidenceSchema = z
  .object({
    path: z.string().min(1).max(4_096),
    lineStart: z.number().int().min(1),
    lineEnd: z.number().int().min(1),
    text: z.string().max(2_000),
    fileHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

const diagnosticsSchema = z
  .object({
    filesRequested: z.number().int().min(0),
    filesLoaded: z.number().int().min(0),
    filesSkipped: z.number().int().min(0),
    metadataFailures: z.number().int().min(0),
    projectFilesRead: z.number().int().min(0),
    assemblyDefinitionsLoaded: z.number().int().min(0),
    referencesLoaded: z.number().int().min(0),
    referenceFailures: z.number().int().min(0),
    parseErrors: z.number().int().min(0),
    unresolvedCandidates: z.number().int().min(0),
    partial: z.boolean(),
    elapsedMs: z.number().int().min(0),
    messages: z.array(z.string().max(4_096)).max(20),
  })
  .strict();

const workerSuccessSchema = z
  .object({
    version: z.literal(1),
    ok: z.literal(true),
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
          })
          .strict(),
      )
      .max(200),
    truncated: z.boolean(),
    diagnostics: diagnosticsSchema,
  })
  .strict();

const workerFailureSchema = z
  .object({
    version: z.literal(1),
    ok: z.literal(false),
    error: z
      .object({
        code: z.string().min(1).max(128),
        message: z.string().min(1).max(4_096),
        candidates: z.array(z.string().max(4_096)).max(1_000),
      })
      .strict(),
    diagnostics: diagnosticsSchema,
  })
  .strict();

const workerResponseSchema = z.discriminatedUnion("ok", [
  workerSuccessSchema,
  workerFailureSchema,
]);

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PACKAGE_ROOT = path.resolve(moduleDirectory, "..", "..");
const MAX_WORKER_OUTPUT_BYTES = 8 * 1024 * 1024;

export function getRoslynWorkerPath(
  packageRoot = DEFAULT_PACKAGE_ROOT,
): string {
  return path.join(
    packageRoot,
    "workers",
    "roslyn",
    "bin",
    "Release",
    "net8.0",
    "ProjectContext.Roslyn.dll",
  );
}

function defaultRunWorker(
  request: RoslynWorkerRequest,
  workerPath: string,
  timeoutMs: number,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn("dotnet", [workerPath], {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      reject(error);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > MAX_WORKER_OUTPUT_BYTES) {
        fail(new Error("Roslyn worker output exceeded the size limit"));
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (Buffer.byteLength(stderr) < 256 * 1024) stderr += chunk;
    });
    child.once("error", (error) => fail(error));
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`Roslyn worker timed out after ${timeoutMs}ms`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout.trim()) as unknown;
        if (code !== 0 && code !== 1) {
          reject(
            new Error(
              stderr.trim() || `Roslyn worker exited with code ${String(code)}`,
            ),
          );
          return;
        }
        resolve(parsed);
      } catch {
        reject(
          new Error(
            stderr.trim() || `Roslyn worker returned invalid JSON (exit ${String(code)})`,
          ),
        );
      }
    });

    child.stdin.once("error", (error) => fail(error));
    child.stdin.end(JSON.stringify(request));
  });
}

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
): GraphSymbolNode {
  if (node.path === null) {
    if (
      node.lineStart !== null ||
      node.lineEnd !== null ||
      node.fileHash !== null
    ) {
      throw new GraphTraceError(
        "Roslyn worker returned source lines without a source path",
        "worker_protocol",
      );
    }
    return node;
  }
  const normalizedPath = node.path.replaceAll("\\", "/");
  if (!allowedFiles.has(pathKey(normalizedPath))) {
    throw new GraphTraceError(
      `Roslyn worker returned a source outside the allowed set: ${node.path}`,
      "worker_protocol",
    );
  }
  if (
    node.lineStart === null ||
    node.lineEnd === null ||
    node.lineEnd < node.lineStart ||
    node.fileHash === null
  ) {
    throw new GraphTraceError(
      "Roslyn worker returned invalid symbol source lines",
      "worker_protocol",
    );
  }
  return { ...node, path: normalizedPath };
}

function workerFailureCode(
  value: string,
): GraphTraceError["code"] {
  if (value === "symbol_not_found" || value === "ambiguous_symbol") return value;
  if (value === "invalid_request" || value === "invalid_symbol" || value === "invalid_direction") {
    return "invalid_request";
  }
  return "worker_failed";
}

export async function traceProject(
  input: {
    projectPath: string;
    symbol: string;
    direction: TraceDirection;
    maxResults?: number;
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
  const relevant = collected.filter((file) => {
    const extension = path.extname(file.relativePath).toLowerCase();
    return extension === ".cs" || extension === ".asmdef";
  });
  const verified = await verifyCollectedFiles(
    project.root,
    relevant,
    targets,
    loadedConfig.value.exclude,
  );
  const sourceFiles = verified.filter(
    (file) => path.extname(file.relativePath).toLowerCase() === ".cs",
  );
  const assemblyDefinitions = verified.filter(
    (file) => path.extname(file.relativePath).toLowerCase() === ".asmdef",
  );
  if (sourceFiles.length === 0) {
    throw new GraphTraceError(
      "No configured C# source files are available",
      "invalid_request",
    );
  }

  const request: RoslynWorkerRequest = {
    version: 1,
    projectRoot: project.root,
    files: sourceFiles.map((file) => file.relativePath),
    assemblyDefinitions: assemblyDefinitions.map((file) => file.relativePath),
    symbol,
    direction: input.direction,
    maxResults,
  };
  const packageRoot = options.packageRoot ?? DEFAULT_PACKAGE_ROOT;
  const workerPath = getRoslynWorkerPath(packageRoot);
  const runWorker = options.dependencies?.runWorker ?? defaultRunWorker;
  let rawResponse: unknown;
  try {
    rawResponse = await runWorker(
      request,
      workerPath,
      options.timeoutMs ?? 90_000,
    );
  } catch (error) {
    throw new GraphTraceError(
      error instanceof Error ? error.message : String(error),
      "worker_unavailable",
    );
  }

  const parsed = workerResponseSchema.safeParse(rawResponse);
  if (!parsed.success) {
    throw new GraphTraceError(
      `Roslyn worker returned an invalid response: ${parsed.error.message}`,
      "worker_protocol",
    );
  }
  if (!parsed.data.ok) {
    throw new GraphTraceError(
      parsed.data.error.message,
      workerFailureCode(parsed.data.error.code),
      parsed.data.error.candidates,
    );
  }
  if (parsed.data.symbol !== symbol || parsed.data.direction !== input.direction) {
    throw new GraphTraceError(
      "Roslyn worker response does not match the request",
      "worker_protocol",
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
        `Roslyn worker returned a source outside the allowed set: ${relativePath}`,
        "worker_protocol",
      );
    }
    current = await readIndexableFile(project.root, sourceFile);
    readCache.set(key, current);
    return current;
  };
  const isFreshNode = async (node: GraphSymbolNode): Promise<boolean> => {
    if (node.path === null) return true;
    const current = await readCurrent(node.path);
    if (current.kind !== "ok" || current.hash !== node.fileHash) return false;
    const lineCount = current.text.replace(/\r\n?/g, "\n").split("\n").length;
    if (node.lineEnd === null || node.lineEnd > lineCount) {
      throw new GraphTraceError(
        "Roslyn worker returned symbol lines outside the current source",
        "worker_protocol",
      );
    }
    return true;
  };
  const matchedSymbols: GraphSymbolNode[] = [];
  let staleSymbolsSkipped = 0;
  for (const rawNode of parsed.data.matchedSymbols) {
    const node = validateNode(rawNode, allowedFiles);
    if (!(await isFreshNode(node))) {
      staleSymbolsSkipped += 1;
      continue;
    }
    matchedSymbols.push(node);
  }
  const results: GraphTraceEdge[] = [];
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
        "Roslyn worker returned evidence lines outside the current source",
        "worker_protocol",
      );
    }
    const excerptEnd = Math.min(edge.evidence.lineEnd, edge.evidence.lineStart + 19);
    const text = lines
      .slice(edge.evidence.lineStart - 1, excerptEnd)
      .join("\n")
      .trim()
      .slice(0, 2_000);
    results.push({
      relation: edge.relation,
      from,
      to,
      evidence: {
        ...edge.evidence,
        path: evidencePath,
        text,
      },
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
    diagnostics: parsed.data.diagnostics,
    results,
    truncated: parsed.data.truncated,
  };
}
