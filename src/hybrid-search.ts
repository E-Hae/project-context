import path from "node:path";

import { searchExact } from "./exact-search.js";
import {
  GraphTraceError,
  traceProject,
  type GraphTraceResult,
  type TraceDirection,
} from "./graph-client.js";
import { searchGraphRag, type GraphRagSearchResult } from "./graphrag-search.js";
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
  | GraphRagSearchResult
  | GraphTraceResult
  | (Omit<SemanticSearchResult, "fallbackUsed"> & { fallbackUsed: true });

interface HybridSearchDependencies {
  searchExact: typeof searchExact;
  searchSemantic: typeof searchSemantic;
  searchGraphRag: typeof searchGraphRag;
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

// Cues stay specific: "X를 사용하는 방법" or "HTTP calls" are ordinary
// questions for GraphRAG, not a reason to run an adapter trace.
const STRUCTURAL_PATTERN =
  /호출|상속|구현|이어지|연결|참조|의존|생성하|발행자|구독|사용처|(?:사용|이용)(?:되|돼|된)|(?:사용|이용)하는\s*(?:곳|위치|코드|메서드|함수|클래스|부분|파일)|쓰이|쓰는\s*곳|부르는|불리|파생|(?:하위|자식|부모|상위|기반|베이스)\s*(?:클래스|타입)|call(?:er|ee| graph)|(?:who|what|which\s+\w+)\s+calls\b|called\s+by|inherit|implement|references?|depends?|\busages\b|find\s+usages?|subclass|\bderive[sd]?\s+from\b|\bderived\s+(?:types?|class(?:es)?)\b|(?:base|parent)\s+(?:types?|class)|super\s*class|\bextends\b|extended\s+by/iu;

// Direction rules run on the query with the traced symbol replaced by this
// marker, so that a Korean particle is read against the symbol it follows:
// "X를 호출하는" asks for callers and "X가 호출하는" asks for callees.
const SYMBOL_MARKER = "\uE000";
const M = SYMBOL_MARKER;
const CALL_VERB = "(?:호출|부르|불러|사용|쓰|참조|의존|이용|연결|생성)";

function rule(alternatives: string[], direction: TraceDirection): readonly [RegExp, TraceDirection] {
  return [new RegExp(alternatives.join("|"), "iu"), direction];
}

// The first matching rule wins, so the reverse type relations and incoming
// references are checked before the forward readings they overlap with.
const DIRECTION_RULES: ReadonlyArray<readonly [RegExp, TraceDirection]> = [
  rule(["피호출", "callees?\\b", "outgoing"], "callees"),
  rule(["(?<!피)호출자", "호출처", "사용처", "참조처", "callers?\\b", "incoming", "usages?\\b"], "callers"),
  rule([
    `${M}\\s*(?:을|를)\\s*(?:직접\\s*)?구현`,
    `${M}\\s+구현\\s*(?:하는|한)`,
    `${M}\\s*(?:의\\s*)?구현\\s*(?:체|타입|클래스|형식|목록)`,
    `누가\\s*(?:${M}\\s*(?:을|를)?\\s*)?구현`,
    "implemented\\s+by",
    "implementations?\\s+of",
    "implementers?\\b",
    `(?:who|what|which\\s+\\w+)\\s+implements?\\s+${M}`,
    "(?:classes|types|structs)\\s+(?:that|which)\\s+implement",
  ], "implementedBy"),
  rule([
    `${M}\\s*(?:을|를)\\s*(?:직접\\s*)?(?:상속|확장)`,
    `${M}\\s+(?:상속|확장)\\s*(?:받는|받은|하는|한)`,
    `${M}\\s*(?:의\\s*)?(?:파생|하위|자식|서브)`,
    `누가\\s*(?:${M}\\s*(?:을|를)?\\s*)?(?:상속|확장)`,
    // "derived from X" lists X's subtypes; "X is derived from" asks for its bases.
    `derived\\s+from\\s+${M}`,
    "derived\\s+(?:types?|classes?)",
    "sub-?(?:types?|classes?)\\b",
    "(?:inherited|extended)\\s+by",
    "children\\s+of",
    `(?:who|what|which\\s+\\w+)\\s+(?:inherits?|extends?|derives?)(?:\\s+from)?\\s+${M}`,
    "(?:classes|types|interfaces)\\s+(?:that|which)\\s+(?:inherit|extend|derive)",
  ], "derived"),
  rule([`${M}\\s*에\\s*(?:의존|참조)`, `${M}\\s*(?:을|를).*?${CALL_VERB}`], "callers"),
  // "X에서 호출되는 메서드" names what runs inside X, so it asks for callees.
  rule([`${M}\\s*(?:의\\s*)?(?:안|내부|내|속)?\\s*에서`], "callees"),
  rule([
    "(?:호출|사용|참조|의존|이용|생성)\\s*(?:되|돼|된|됨)",
    "불리|불려|불린|쓰이|쓰여|쓰인",
    // A question word as the subject ("누가", "어떤 메서드가") or a place
    // ("어디서", "어느 파일에서") asks what reaches the symbol. A bare "에"
    // does not: in "X는 어디에 의존해?" it names what X depends on.
    `(?:누가|누구가|무엇이|뭐가|(?:어떤|어느)\\s*\\S+?\\s*(?:이|가)\\s|어디(?:서|에서)|(?:어떤|어느)\\s*\\S+?에서\\s).*?${CALL_VERB}`,
  ], "callers"),
  rule([`${M}\\s*(?:이|가|은|는)\\s.*?${CALL_VERB}`], "callees"),
  rule([
    `${M}\\s+(?:(?:호출|사용|참조|이용)\\s*(?:하|한|할|해)|부르|부른|불러|쓰는|쓴|(?:호출|사용|참조)\\s*(?:위치|지점))`,
    "(?:who|what)\\s+(?:calls|uses|references?|invokes|depends\\s+on)",
    `${M}\\s+(?:is|are|gets?)\\s+(?:called|used|referenced|invoked)`,
    `references?\\s+to\\s+${M}`,
    "(?:find|list|show)\\s+(?:all\\s+)?(?:references|usages)",
  ], "callers"),
  rule([
    "상속",
    "(?:부모|상위|기반|베이스)\\s*(?:클래스|타입)",
    `${M}\\s+(?:is\\s+|was\\s+)?derive[sd]\\s+from`,
    "base\\s+(?:types?|class(?:es)?)",
    "super\\s*class",
    "parent\\s+(?:types?|class(?:es)?)",
    "inherits?",
    "\\bextends?\\b",
  ], "inherits"),
  rule(["구현", "implements?", "interfaces?"], "implements"),
];
// Adapters differ on whether an interface's base interfaces are inherited or
// implemented, so an empty type relation also points at the sibling direction.
const ALTERNATIVE_DIRECTIONS: Readonly<Record<TraceDirection, readonly TraceDirection[]>> = {
  callers: ["callees"],
  callees: ["callers"],
  inherits: ["derived", "implements"],
  derived: ["inherits", "implementedBy"],
  implements: ["implementedBy", "inherits"],
  implementedBy: ["implements", "derived"],
};
const PATH_PATTERN = /(?:^|[\\/])[\w .@()\-]+\.[A-Za-z0-9]+(?:$|\s)|\.(?:cs|asmdef|json|ya?ml|md|asset)\b/iu;
const ERROR_PATTERN = /\b(?:CS\d{4}|0x[0-9a-f]+|[A-Za-z_]\w*(?:Exception|Error))\b|오류|에러/iu;
const WHOLE_IDENTIFIER_PATTERN =
  /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*(?:\([^()\r\n]{0,256}\))?$/u;
// The bare-name branches start at a word boundary: without it "extractGraphDirection"
// matched from its first capital and traced "GraphDirection". The camelCase branch
// needs two characters after the inner capital, so an acronym word such as "iOS"
// cannot shadow the real symbol later in the query while "parseXML" still matches.
const SYMBOL_CANDIDATE_PATTERN =
  /[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+(?:\([^()\r\n]{0,256}\))?|[A-Za-z_]\w*\([^()\r\n]{0,256}\)|\b[A-Z][A-Za-z0-9_]{2,}|\b[a-z_]\w*[A-Z]\w{2,}/gu;
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
  "what",
  "who",
  "how",
  "why",
  "when",
  "does",
  "find",
  "show",
  "list",
]);

export function extractGraphDirection(
  query: string,
  symbol: string | null = extractGraphSymbol(query),
): TraceDirection {
  const masked = symbol
    ? query
      .replaceAll(symbol, SYMBOL_MARKER)
      .replace(new RegExp(`["'\`](${SYMBOL_MARKER})["'\`]`, "gu"), "$1")
    : query;
  return DIRECTION_RULES.find(([pattern]) => pattern.test(masked))?.[1] ?? "callees";
}

/** Keeps an empty graph answer from reading as "nothing is related". */
function withInferredDirectionHint(result: GraphTraceResult): GraphTraceResult {
  if (result.results.length > 0) return result;
  const alternatives = ALTERNATIVE_DIRECTIONS[result.direction]
    .map((direction) => `"${direction}"`)
    .join(" or ");
  const hint = `No ${result.direction} relationships were found for ${result.symbol}. The ${result.direction} direction was inferred from the query text; if the question asked for another relationship, trace again with direction ${alternatives}.`;
  return {
    ...result,
    diagnostics: {
      ...result.diagnostics,
      messages: [hint, ...result.diagnostics.messages].slice(0, 20),
    },
  };
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
        direction: extractGraphDirection(trimmed, symbol),
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
  return { symbol, direction: extractGraphDirection(query, symbol) };
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
    searchGraphRag,
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
    if (mode === "auto" && scope !== "documents") {
      return dependencies.searchGraphRag(
        {
          projectPath: input.projectPath,
          query: input.query,
          scope,
          maxResults,
        },
        {
          ...(options.stateRoot === undefined ? {} : { stateRoot: options.stateRoot }),
          ...(options.semantic?.handoffRoot === undefined
            ? {}
            : { handoffRoot: options.semantic.handoffRoot }),
        },
      );
    }
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
        if (graph.results.length > 0) return graph;
        if (mode === "graph") return withInferredDirectionHint(graph);
      } catch (error) {
        if (
          !(error instanceof GraphTraceError) ||
          (error.code !== "symbol_not_found" &&
            error.code !== "adapter_unavailable" &&
            error.code !== "unsupported_direction") ||
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
