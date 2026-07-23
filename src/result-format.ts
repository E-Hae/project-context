import type { SearchScope, SourceKind } from "./source-policy.js";

export interface EvidenceResult {
  source: SourceKind;
  path: string;
  documentId?: string;
  title?: string;
  date?: string | null;
  matchKind: "content" | "path" | "semantic";
  lineStart: number | null;
  lineEnd: number | null;
  text: string;
  score: number | null;
  indexedAt: string | null;
  commit: string | null;
}

export interface ExactSearchResult {
  route: "exact";
  fallbackUsed: false;
  query: string;
  scope: SearchScope;
  commit: string | null;
  indexedAt: null;
  results: EvidenceResult[];
  truncated: boolean;
}

export interface SemanticSearchResult {
  route: "semantic";
  fallbackUsed: false;
  query: string;
  scope: SearchScope;
  commit: string | null;
  indexCommit: string | null;
  indexedAt: string;
  stale: boolean;
  queryExpansion: {
    used: boolean;
    model: string | null;
    expandedQuery: string | null;
    identifierQuery: string | null;
    error: string | null;
  };
  staleResultsSkipped: number;
  results: EvidenceResult[];
  truncated: boolean;
}

export interface DocumentReadResult extends Omit<
  EvidenceResult,
  "matchKind" | "lineStart" | "lineEnd"
> {
  matchKind: "content";
  lineStart: number;
  lineEnd: number;
  requestedEndLine: number;
}
