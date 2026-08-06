import type {
  TraceAdapter,
  TraceAdapterGraphResponse,
  TraceAdapterRequest,
  TraceAdapterResponse,
  TraceDiagnostics,
  TraceSymbol,
} from "project-context-mcp/trace-adapter";

import { probeRoslynWorker, runRoslynWorker } from "./worker-client.js";

interface RoslynSymbol {
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

interface RoslynDiagnostics {
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

interface RoslynSuccess {
  version: 1;
  ok: true;
  workerVersion: string;
  symbol: string;
  direction: TraceAdapterRequest["direction"];
  matchedSymbols: RoslynSymbol[];
  diagnostics: RoslynDiagnostics;
  results: Array<{
    relation: string;
    from: RoslynSymbol;
    to: RoslynSymbol;
    evidence: {
      path: string;
      lineStart: number;
      lineEnd: number;
      text: string;
      fileHash: string;
    };
  }>;
  truncated: boolean;
}

interface RoslynFailure {
  version: 1;
  ok: false;
  error: {
    code: string;
    message: string;
    candidates: string[];
  };
}

interface RoslynGraphSuccess {
  version: 1;
  ok: true;
  operation: "build_graph";
  workerVersion: string;
  nodes: RoslynSymbol[];
  diagnostics: RoslynDiagnostics;
  results: Array<{
    relation: string;
    from: number | RoslynSymbol;
    to: number | RoslynSymbol;
    evidence: {
      path: string;
      lineStart: number;
      lineEnd: number;
      fileHash: string;
    };
  }>;
  truncated: boolean;
}

const MAX_CSHARP_GRAPH_NODES = 5_000;
const MAX_CSHARP_GRAPH_EDGES = 10_000;

function isRoslynResponse(value: unknown): value is RoslynSuccess | RoslynFailure {
  if (typeof value !== "object" || value === null) return false;
  const response = value as Record<string, unknown>;
  return response.version === 1 && typeof response.ok === "boolean";
}

function isRoslynGraphResponse(value: unknown): value is RoslynGraphSuccess | RoslynFailure {
  if (typeof value !== "object" || value === null) return false;
  const response = value as Record<string, unknown>;
  return response.version === 1 && typeof response.ok === "boolean" &&
    (response.ok === false || response.operation === "build_graph");
}

type CsharpAdapterErrorCode =
  | "unavailable"
  | "failed"
  | "invalid_request"
  | "symbol_not_found"
  | "ambiguous_symbol";

class CsharpAdapterError extends Error {
  constructor(
    message: string,
    readonly code: CsharpAdapterErrorCode,
    readonly candidates: string[] = [],
  ) {
    super(message);
    this.name = "CsharpAdapterError";
  }
}

function adapterFailureCode(value: string): CsharpAdapterErrorCode {
  if (value === "symbol_not_found" || value === "ambiguous_symbol") return value;
  if (value === "invalid_request" || value === "invalid_symbol" || value === "invalid_direction") {
    return "invalid_request";
  }
  return "failed";
}

function toTraceSymbol(symbol: RoslynSymbol): TraceSymbol {
  return {
    name: symbol.name,
    fullName: symbol.fullName,
    signature: symbol.signature,
    kind: symbol.kind,
    path: symbol.path,
    lineStart: symbol.lineStart,
    lineEnd: symbol.lineEnd,
    fileHash: symbol.fileHash,
    metadata: {
      assembly: symbol.assembly,
      unityMessage: symbol.unityMessage,
    },
  };
}

function toTraceDiagnostics(diagnostics: RoslynDiagnostics): TraceDiagnostics {
  return {
    filesRequested: diagnostics.filesRequested,
    filesLoaded: diagnostics.filesLoaded,
    filesSkipped: diagnostics.filesSkipped,
    partial: diagnostics.partial,
    elapsedMs: diagnostics.elapsedMs,
    messages: diagnostics.messages,
    metadata: {
      metadataFailures: diagnostics.metadataFailures,
      projectFilesRead: diagnostics.projectFilesRead,
      assemblyDefinitionsLoaded: diagnostics.assemblyDefinitionsLoaded,
      referencesLoaded: diagnostics.referencesLoaded,
      referenceFailures: diagnostics.referenceFailures,
      parseErrors: diagnostics.parseErrors,
      unresolvedCandidates: diagnostics.unresolvedCandidates,
    },
  };
}

export function createCsharpTraceAdapter(
  runWorker: typeof runRoslynWorker = runRoslynWorker,
  probeWorker: typeof probeRoslynWorker = probeRoslynWorker,
): TraceAdapter {
  return {
    name: "project-context-mcp-csharp",
    language: "csharp",
    sourceFileExtensions: [".cs"],
    auxiliaryFileExtensions: [".asmdef"],
    async probe() {
      try {
        const version = await probeWorker();
        return {
          available: true,
          detail: `Roslyn worker ${version} is available`,
          version,
        };
      } catch (error) {
        return {
          available: false,
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    },
    async trace(request) {
      let response: unknown;
      try {
        response = await runWorker({
          version: 1,
          projectRoot: request.projectRoot,
          files: request.files,
          assemblyDefinitions: request.auxiliaryFiles,
          symbol: request.symbol,
          direction: request.direction,
          maxResults: request.maxResults,
        });
      } catch (error) {
        throw new CsharpAdapterError(
          error instanceof Error ? error.message : String(error),
          "unavailable",
        );
      }
      if (!isRoslynResponse(response)) {
        throw new CsharpAdapterError("Roslyn worker returned an invalid response", "failed");
      }
      if (!response.ok) {
        throw new CsharpAdapterError(
          response.error.message,
          adapterFailureCode(response.error.code),
          response.error.candidates,
        );
      }
      return {
        workerVersion: response.workerVersion,
        symbol: response.symbol,
        direction: response.direction,
        matchedSymbols: response.matchedSymbols.map(toTraceSymbol),
        diagnostics: toTraceDiagnostics(response.diagnostics),
        results: response.results.map((result) => ({
          relation: result.relation,
          from: toTraceSymbol(result.from),
          to: toTraceSymbol(result.to),
          evidence: result.evidence,
        })),
        truncated: response.truncated,
      } satisfies TraceAdapterResponse;
    },
    async buildGraph(request): Promise<TraceAdapterGraphResponse> {
      let response: unknown;
      try {
        response = await runWorker({
          version: 1,
          operation: "build_graph",
          projectRoot: request.projectRoot,
          files: request.files,
          assemblyDefinitions: request.auxiliaryFiles,
          maxNodes: Math.min(request.maxNodes, MAX_CSHARP_GRAPH_NODES),
          maxEdges: Math.min(request.maxEdges, MAX_CSHARP_GRAPH_EDGES),
        });
      } catch (error) {
        throw new CsharpAdapterError(
          error instanceof Error ? error.message : String(error),
          "unavailable",
        );
      }
      if (!isRoslynGraphResponse(response)) {
        throw new CsharpAdapterError("Roslyn worker returned an invalid graph response", "failed");
      }
      if (!response.ok) {
        throw new CsharpAdapterError(
          response.error.message,
          adapterFailureCode(response.error.code),
          response.error.candidates,
        );
      }
      return {
        workerVersion: response.workerVersion,
        nodes: response.nodes.map(toTraceSymbol),
        diagnostics: toTraceDiagnostics(response.diagnostics),
        results: response.results.map((result) => {
          const from = typeof result.from === "number"
            ? response.nodes[result.from]
            : result.from;
          const to = typeof result.to === "number"
            ? response.nodes[result.to]
            : result.to;
          if (from === undefined || to === undefined) {
            throw new CsharpAdapterError("Roslyn worker graph edge references a missing node", "failed");
          }
          return {
            relation: result.relation,
            from: toTraceSymbol(from),
            to: toTraceSymbol(to),
            evidence: result.evidence,
          };
        }),
        truncated: response.truncated,
      } satisfies TraceAdapterGraphResponse;
    },
  };
}

export const traceAdapter = createCsharpTraceAdapter();
