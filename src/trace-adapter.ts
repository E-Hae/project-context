export type TraceDirection =
  | "callers"
  | "callees"
  | "inherits"
  | "implements";

export type TraceAdapterMetadataValue = string | number | boolean | null;
export type TraceAdapterMetadata = Record<string, TraceAdapterMetadataValue>;

export interface TraceSymbol {
  name: string;
  fullName: string;
  signature: string;
  kind: string;
  path: string | null;
  lineStart: number | null;
  lineEnd: number | null;
  fileHash: string | null;
  metadata?: TraceAdapterMetadata;
}

export interface TraceAdapterEvidence {
  path: string;
  lineStart: number;
  lineEnd: number;
  text: string;
  fileHash: string;
  metadata?: TraceAdapterMetadata;
}

export interface TraceAdapterEdge {
  relation: string;
  from: TraceSymbol;
  to: TraceSymbol;
  evidence: TraceAdapterEvidence;
  metadata?: TraceAdapterMetadata;
}

export interface TraceDiagnostics {
  filesRequested: number;
  filesLoaded: number;
  filesSkipped: number;
  partial: boolean;
  elapsedMs: number;
  messages: string[];
  metadata?: TraceAdapterMetadata;
}

export interface TraceAdapterRequest {
  projectRoot: string;
  files: string[];
  auxiliaryFiles: string[];
  symbol: string;
  direction: TraceDirection;
  maxResults: number;
  adapterConfig?: {
    unity: {
      mode: "yaml" | "batch";
      editorVersion: string | null;
      batchTimeoutSeconds: number;
    };
  };
}

export interface TraceAdapterResponse {
  workerVersion: string;
  symbol: string;
  direction: TraceDirection;
  matchedSymbols: TraceSymbol[];
  diagnostics: TraceDiagnostics;
  results: TraceAdapterEdge[];
  truncated: boolean;
}

/**
 * A whole-project, source-backed graph.  Graph snapshots intentionally keep
 * only edge locations, rather than source excerpts, because the core reads
 * current source again before returning GraphRAG evidence.
 */
export interface TraceAdapterGraphEdge {
  relation: string;
  from: TraceSymbol;
  to: TraceSymbol;
  evidence: Pick<
    TraceAdapterEvidence,
    "path" | "lineStart" | "lineEnd" | "fileHash"
  >;
  metadata?: TraceAdapterMetadata;
}

export interface TraceAdapterGraphRequest {
  projectRoot: string;
  files: string[];
  auxiliaryFiles: string[];
  maxNodes: number;
  maxEdges: number;
  adapterConfig?: TraceAdapterRequest["adapterConfig"];
}

export interface TraceAdapterGraphResponse {
  workerVersion: string;
  nodes: TraceSymbol[];
  results: TraceAdapterGraphEdge[];
  diagnostics: TraceDiagnostics;
  truncated: boolean;
}

export interface TraceAdapterProbeResult {
  available: boolean;
  detail: string;
  version?: string;
  metadata?: TraceAdapterMetadata;
}

export interface TraceAdapter {
  name: string;
  language: string;
  languageAliases?: readonly string[];
  sourceFileExtensions: readonly string[];
  auxiliaryFileExtensions?: readonly string[];
  probe(): Promise<TraceAdapterProbeResult>;
  trace(request: TraceAdapterRequest): Promise<TraceAdapterResponse>;
  /** Optional so existing third-party trace-only adapters remain compatible. */
  buildGraph?(request: TraceAdapterGraphRequest): Promise<TraceAdapterGraphResponse>;
}

export class TraceAdapterError extends Error {
  constructor(
    message: string,
    readonly code:
      | "unavailable"
      | "failed"
      | "invalid_request"
      | "symbol_not_found"
      | "ambiguous_symbol",
    readonly candidates: string[] = [],
  ) {
    super(message);
    this.name = "TraceAdapterError";
  }
}
