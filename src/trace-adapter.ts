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
