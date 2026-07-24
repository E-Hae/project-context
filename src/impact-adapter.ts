export interface ImpactAdapterRequest {
  projectRoot: string;
  target: string;
  maxResults: number;
  historyLimit: number;
}

export interface ImpactFile {
  path: string;
  cochangeCount: number;
  lastChangedAt: string | null;
  commits: string[];
}

export interface ImpactAdapterResponse {
  workerVersion: string;
  target: string;
  commitsAnalyzed: number;
  results: ImpactFile[];
  truncated: boolean;
  diagnostics: {
    elapsedMs: number;
    messages: string[];
  };
}

export interface ImpactAdapterProbeResult {
  available: boolean;
  detail: string;
  version?: string;
}

export interface ImpactAdapter {
  name: string;
  language: string;
  probe(): Promise<ImpactAdapterProbeResult>;
  analyze(request: ImpactAdapterRequest): Promise<ImpactAdapterResponse>;
}

export class ImpactAdapterError extends Error {
  constructor(
    message: string,
    readonly code: "unavailable" | "failed" | "invalid_request" | "target_not_found",
  ) {
    super(message);
    this.name = "ImpactAdapterError";
  }
}
