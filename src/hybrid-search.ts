import path from "node:path";

import { searchExact } from "./exact-search.js";
import {
  GraphTraceError,
  traceProject,
  type GraphTraceResult,
  type TraceDirection,
} from "./graph-client.js";
import type {
  ExactSearchResult,
  SemanticSearchResult,
} from "./result-format.js";
import { searchSemantic } from "./semantic-search.js";
import type { SearchScope } from "./source-policy.js";

export type SearchMode = "auto" | "exact" | "graph" | "semantic";
type ExactSearchInput = Parameters<typeof searchExact>[0];
type SemanticSearchInput = Parameters<typeof searchSemantic>[0];
type SemanticSearchOptions = NonNullable<Parameters<typeof searchSemantic>[1]>;

export interface SearchRouteDecision {
  route: Exclude<SearchMode, "auto">;
  symbol: string | null;
  direction: TraceDirection | null;
}

export type HybridSearchResult =
  | ExactSearchResult
  | SemanticSearchResult
  | GraphTraceResult
  | (Omit<SemanticSearchResult, "fallbackUsed"> & { fallbackUsed: true });

interface HybridSearchDependencies {
  searchExact: typeof searchExact;
  searchSemantic: typeof searchSemantic;
  traceProject: typeof traceProject;
}

export interface HybridSearchOptions {
  stateRoot?: string;
  semantic?: Omit<SemanticSearchOptions, "stateRoot">;
  dependencies?: Partial<HybridSearchDependencies>;
}

export class HybridSearchError extends Error {
  constructor(
    message: string,
    readonly code: "invalid_graph_query" | "invalid_request" | "invalid_scope",
  ) {
    super(message);
    this.name = "HybridSearchError";
  }
}

const STRUCTURAL_PATTERN =
  /호출|상속|구현|이어지|연결|참조|의존|생성하|발행자|구독|call(?:er|ee| graph)|who calls|inherit|implement|references?|depends?/iu;
const CALLERS_PATTERN =
  /호출자|누가\s*호출|(?:무엇|뭐|누가|어디서).{0,40}(?:참조|의존)|에\s*(?:참조|의존)하는|callers?|who calls|what\s+references?|who\s+depends?\s+on/iu;
const INHERITS_PATTERN = /상속|inherits?|base\s+type|derived\s+type/iu;
const IMPLEMENTS_PATTERN = /구현|implements?|interface/iu;
const PATH_PATTERN = /(?:^|[\\/])[\w .@()\-]+\.[A-Za-z0-9]+(?:$|\s)|\.(?:cs|asmdef|json|ya?ml|md|asset)\b/iu;
const ERROR_PATTERN = /\b(?:CS\d{4}|0x[0-9a-f]+|[A-Za-z_]\w*(?:Exception|Error))\b|오류|에러/iu;
const WHOLE_IDENTIFIER_PATTERN =
  /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*(?:\([^()\r\n]{0,256}\))?$/u;
const SYMBOL_CANDIDATE_PATTERN =
  /[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+(?:\([^()\r\n]{0,256}\))?|[A-Za-z_]\w*\([^()\r\n]{0,256}\)|[A-Z][A-Za-z0-9_]{2,}/gu;
const QUOTED_PATH_CANDIDATE_PATTERN =
  /["'`]([^"'`\r\n]*[\\/][^"'`\r\n]*\.[A-Za-z0-9]+)["'`]/u;
const PATH_CANDIDATE_PATTERN =
  /(?:[A-Za-z]:[\\/])?(?:[^\\/\s"'<>|?*]+[\\/])+[^\\/\s"'<>|?*]+\.[A-Za-z0-9]+/u;
const BARE_FILE_CANDIDATE_PATTERN =
  /\b[A-Za-z0-9_@()\-]+\.(?:asmdef|asmref|asset|cs|js|jsx|meta|prefab|ts|tsx|unity)\b/iu;
const SYMBOL_STOP_WORDS = new Set([
  "call",
  "caller",
  "callers",
  "callee",
  "callees",
  "interface",
  "where",
  "which",
]);

export function extractGraphDirection(query: string): TraceDirection {
  if (CALLERS_PATTERN.test(query)) return "callers";
  if (INHERITS_PATTERN.test(query)) return "inherits";
  if (IMPLEMENTS_PATTERN.test(query)) return "implements";
  return "callees";
}

export function extractGraphSymbol(query: string): string | null {
  const quotedPath = query.match(QUOTED_PATH_CANDIDATE_PATTERN)?.[1]?.trim();
  if (quotedPath) return quotedPath;
  const pathCandidate = query.match(PATH_CANDIDATE_PATTERN)?.[0]?.trim();
  if (pathCandidate) return pathCandidate;
  const bareFileCandidate = query.match(BARE_FILE_CANDIDATE_PATTERN)?.[0]?.trim();
  if (bareFileCandidate) return bareFileCandidate;
  const candidates = query.match(SYMBOL_CANDIDATE_PATTERN) ?? [];
  for (const candidate of candidates) {
    const value = candidate.trim();
    if (value.includes(".") || value.includes("(")) return value;
    const simpleName = value.split(/[.(]/, 1)[0] ?? value;
    if (!SYMBOL_STOP_WORDS.has(simpleName.toLocaleLowerCase("en-US"))) {
      return value;
    }
  }
  return null;
}

function sourceExtensionsFromExactResult(result: ExactSearchResult): string[] {
  return [...new Set(
    result.results
      .filter((entry) => entry.source === "code")
      .map((entry) => path.extname(entry.path).toLocaleLowerCase("en-US"))
      .filter((extension) => extension.length > 1),
  )];
}

export function decideSearchRoute(
  query: string,
  scope: SearchScope,
): SearchRouteDecision {
  const trimmed = query.trim();
  if (scope !== "documents" && STRUCTURAL_PATTERN.test(trimmed)) {
    const symbol = extractGraphSymbol(trimmed);
    if (symbol !== null) {
      return {
        route: "graph",
        symbol,
        direction: extractGraphDirection(trimmed),
      };
    }
  }
  if (
    PATH_PATTERN.test(trimmed) ||
    ERROR_PATTERN.test(trimmed) ||
    WHOLE_IDENTIFIER_PATTERN.test(trimmed)
  ) {
    return { route: "exact", symbol: null, direction: null };
  }
  return { route: "semantic", symbol: null, direction: null };
}

function graphRequest(query: string): {
  symbol: string;
  direction: TraceDirection;
} {
  const symbol = extractGraphSymbol(query);
  if (symbol === null) {
    throw new HybridSearchError(
      "Graph search requires a type or method symbol; use context_trace to provide one explicitly",
      "invalid_graph_query",
    );
  }
  return { symbol, direction: extractGraphDirection(query) };
}

export async function searchProject(
  input: {
    projectPath: string;
    query: string;
    mode?: SearchMode;
    scope?: SearchScope;
    maxResults?: number;
    language?: string;
  },
  options: HybridSearchOptions = {},
): Promise<HybridSearchResult> {
  const mode = input.mode ?? "auto";
  const scope = input.scope ?? "all";
  const maxResults = input.maxResults ?? 50;
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 200) {
    throw new HybridSearchError(
      "maxResults must be an integer between 1 and 200",
      "invalid_request",
    );
  }
  const dependencies: HybridSearchDependencies = {
    searchExact,
    searchSemantic,
    traceProject,
    ...options.dependencies,
  };
  const exactInput: ExactSearchInput = {
    projectPath: input.projectPath,
    query: input.query,
    scope,
    maxResults,
  };
  const semanticInput: SemanticSearchInput = { ...exactInput };
  const semanticOptions: SemanticSearchOptions = {
    ...(options.semantic ?? {}),
    ...(options.stateRoot === undefined ? {} : { stateRoot: options.stateRoot }),
  };
  const traceGraph = async (
    symbol: string,
    direction: TraceDirection,
  ): Promise<GraphTraceResult> => {
    const traceInput = {
      projectPath: input.projectPath,
      symbol,
      direction,
      maxResults,
      ...(input.language === undefined ? {} : { language: input.language }),
    };
    try {
      return await dependencies.traceProject(traceInput);
    } catch (error) {
      if (
        !(error instanceof GraphTraceError) ||
        error.code !== "trace_language_required" ||
        input.language !== undefined
      ) {
        throw error;
      }
      let exact: ExactSearchResult;
      try {
        exact = await dependencies.searchExact({
          ...exactInput,
          query: symbol,
          scope: "code",
        });
      } catch {
        throw error;
      }
      const sourceFileExtensions = sourceExtensionsFromExactResult(exact);
      if (sourceFileExtensions.length === 0) throw error;
      return dependencies.traceProject({
        ...traceInput,
        sourceFileExtensions,
      });
    }
  };

  if (mode === "exact") return dependencies.searchExact(exactInput);
  if (mode === "semantic") {
    return dependencies.searchSemantic(semanticInput, semanticOptions);
  }
  if (mode === "graph" && scope === "documents") {
    throw new HybridSearchError(
      "Graph search only supports code or all scope",
      "invalid_scope",
    );
  }

  const decision = mode === "graph"
    ? { route: "graph" as const, ...graphRequest(input.query) }
    : decideSearchRoute(input.query, scope);

  if (decision.route === "semantic") {
    return dependencies.searchSemantic(semanticInput, semanticOptions);
  }
  if (decision.route === "exact") {
    const exact = await dependencies.searchExact(exactInput);
    if (exact.results.length > 0) return exact;
  } else {
    if (decision.symbol === null || decision.direction === null) {
      if (mode === "graph") graphRequest(input.query);
    } else {
      try {
        const graph = await traceGraph(decision.symbol, decision.direction);
        if (graph.results.length > 0 || mode === "graph") return graph;
      } catch (error) {
        if (
          !(error instanceof GraphTraceError) ||
          (error.code !== "symbol_not_found" &&
            error.code !== "adapter_unavailable") ||
          mode === "graph"
        ) {
          throw error;
        }
      }
    }
  }

  const fallback = await dependencies.searchSemantic(
    semanticInput,
    semanticOptions,
  );
  return { ...fallback, fallbackUsed: true };
}
