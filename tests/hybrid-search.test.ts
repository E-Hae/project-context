import assert from "node:assert/strict";
import test from "node:test";

import {
  GraphTraceError,
  type GraphTraceResult,
  type TraceProjectInput,
} from "../src/graph-client.js";
import {
  decideSearchRoute,
  extractGraphDirection,
  extractGraphSymbol,
  HybridSearchError,
  searchProject,
} from "../src/hybrid-search.js";
import type {
  ExactSearchResult,
  SemanticSearchResult,
} from "../src/result-format.js";

function exactResult(withEvidence: boolean): ExactSearchResult {
  return {
    route: "exact",
    fallbackUsed: false,
    query: "query",
    scope: "all",
    commit: null,
    indexedAt: null,
    results: withEvidence
      ? [
          {
            source: "code",
            path: "src/Feature.cs",
            matchKind: "content",
            lineStart: 1,
            lineEnd: 1,
            text: "Feature",
            score: null,
            indexedAt: null,
            commit: null,
          },
        ]
      : [],
    truncated: false,
  };
}

function semanticResult(): SemanticSearchResult {
  return {
    route: "semantic",
    fallbackUsed: false,
    query: "query",
    scope: "all",
    commit: null,
    indexCommit: null,
    indexedAt: "2026-07-14T00:00:00.000Z",
    stale: false,
    queryExpansion: {
      used: false,
      model: null,
      expandedQuery: null,
      identifierQuery: null,
      error: null,
    },
    staleResultsSkipped: 0,
    results: [],
    truncated: false,
  };
}

function graphResult(withEdge: boolean): GraphTraceResult {
  return {
    route: "graph",
    fallbackUsed: false,
    symbol: "Feature.Target",
    direction: "callers",
    commit: null,
    analyzedAt: "2026-07-14T00:00:00.000Z",
    workerVersion: "fixture-worker/1.0",
    stale: false,
    staleResultsSkipped: 0,
    staleSymbolsSkipped: 0,
    matchedSymbols: [],
    diagnostics: {
      filesRequested: 1,
      filesLoaded: 1,
      filesSkipped: 0,
      partial: false,
      elapsedMs: 1,
      messages: [],
    },
    results: withEdge
      ? [
          {
            relation: "calls",
            from: {
              name: "Caller",
              fullName: "Caller.Invoke",
              signature: "Caller.Invoke()",
              kind: "method",
              path: "src/Caller.cs",
              lineStart: 1,
              lineEnd: 1,
              fileHash: "a".repeat(64),
              metadata: { assembly: "Fixture", unityMessage: false },
            },
            to: {
              name: "Target",
              fullName: "Feature.Target",
              signature: "Feature.Target()",
              kind: "method",
              path: "src/Feature.cs",
              lineStart: 1,
              lineEnd: 1,
              fileHash: "b".repeat(64),
              metadata: { assembly: "Fixture", unityMessage: false },
            },
            evidence: {
              path: "src/Caller.cs",
              lineStart: 1,
              lineEnd: 1,
              text: "Target();",
              fileHash: "a".repeat(64),
            },
          },
        ]
      : [],
    truncated: false,
  };
}

test("auto routing separates exact, graph, and semantic questions", () => {
  assert.equal(decideSearchRoute("Loader.CreateLoadingState", "all").route, "exact");
  assert.equal(decideSearchRoute("Assets/Scripts/Loader.cs", "all").route, "exact");
  assert.equal(decideSearchRoute("CS0123 오류", "all").route, "exact");
  assert.deepEqual(
    decideSearchRoute("QuestManager.MoveToQuestPosition의 호출자는?", "all"),
    {
      route: "graph",
      symbol: "QuestManager.MoveToQuestPosition",
      direction: "callers",
    },
  );
  assert.equal(
    decideSearchRoute("Loader.CreateLoadingState가 생성하는 타입", "all").route,
    "graph",
  );
  assert.equal(
    decideSearchRoute("게임 시작 로딩 흐름은 어디에 있나?", "all").route,
    "semantic",
  );
  assert.equal(
    decideSearchRoute("TargetHpUI 호출 관계", "documents").route,
    "semantic",
  );
  assert.equal(decideSearchRoute("호출 관계를 보여줘", "all").route, "semantic");
  assert.equal(extractGraphSymbol("Feature.Overload(int) 호출자"), "Feature.Overload(int)");
  assert.equal(extractGraphSymbol("Overload(int) 호출자"), "Overload(int)");
  assert.equal(extractGraphSymbol("process(int) callers"), "process(int)");
  assert.equal(extractGraphSymbol("Caller.Submit() 호출자"), "Caller.Submit()");
  assert.equal(extractGraphSymbol("CALLER of Target"), "Target");
  assert.equal(
    extractGraphSymbol("Assets/UI/Popup.prefab이 연결하는 스크립트"),
    "Assets/UI/Popup.prefab",
  );
  assert.equal(extractGraphSymbol("Popup.prefab 연결 대상"), "Popup.prefab");
  assert.deepEqual(
    decideSearchRoute("Assets/UI/Popup.prefab이 연결하는 스크립트", "all"),
    {
      route: "graph",
      symbol: "Assets/UI/Popup.prefab",
      direction: "callees",
    },
  );
  assert.equal(extractGraphDirection("what references Feature.Target?"), "callers");
  assert.equal(extractGraphDirection("who depends on Feature.Target?"), "callers");
  assert.equal(extractGraphDirection("무엇이 Feature.Target을 참조해?"), "callers");
  assert.equal(extractGraphDirection("Feature.Target references what?"), "callees");
  assert.equal(extractGraphDirection("IFeature 구현 타입"), "implements");
});

test("explicit search modes are honored without fallback", async () => {
  let semanticCalls = 0;
  let graphLanguage: string | undefined;
  const dependencies = {
    searchExact: async () => exactResult(false),
    searchSemantic: async () => {
      semanticCalls += 1;
      return semanticResult();
    },
    traceProject: async (input: TraceProjectInput) => {
      graphLanguage = input.language;
      return graphResult(false);
    },
  };

  const exact = await searchProject(
    { projectPath: ".", query: "MissingIdentifier", mode: "exact" },
    { dependencies },
  );
  assert.equal(exact.route, "exact");
  assert.equal(semanticCalls, 0);

  const graph = await searchProject(
    {
      projectPath: ".",
      query: "Feature.Target 호출자",
      mode: "graph",
      language: "csharp",
    },
    { dependencies },
  );
  assert.equal(graph.route, "graph");
  assert.equal(graphLanguage, "csharp");
  assert.equal(semanticCalls, 0);

  const semantic = await searchProject(
    { projectPath: ".", query: "intent", mode: "semantic" },
    { dependencies },
  );
  assert.equal(semantic.route, "semantic");
  assert.equal(semanticCalls, 1);
});

test("auto mode falls back once only for an empty exact or graph route", async () => {
  let exactHasEvidence = false;
  let graphHasEdge = false;
  let semanticCalls = 0;
  const dependencies = {
    searchExact: async () => exactResult(exactHasEvidence),
    searchSemantic: async () => {
      semanticCalls += 1;
      return semanticResult();
    },
    traceProject: async () => graphResult(graphHasEdge),
  };

  const exactFallback = await searchProject(
    { projectPath: ".", query: "MissingIdentifier", mode: "auto" },
    { dependencies },
  );
  assert.equal(exactFallback.route, "semantic");
  assert.equal(exactFallback.fallbackUsed, true);

  exactHasEvidence = true;
  const exact = await searchProject(
    { projectPath: ".", query: "KnownIdentifier", mode: "auto" },
    { dependencies },
  );
  assert.equal(exact.route, "exact");
  assert.equal(exact.fallbackUsed, false);

  const graphFallback = await searchProject(
    { projectPath: ".", query: "Feature.Target 호출자", mode: "auto" },
    { dependencies },
  );
  assert.equal(graphFallback.route, "semantic");
  assert.equal(graphFallback.fallbackUsed, true);

  graphHasEdge = true;
  const graph = await searchProject(
    { projectPath: ".", query: "Feature.Target 호출자", mode: "auto" },
    { dependencies },
  );
  assert.equal(graph.route, "graph");
  assert.equal(semanticCalls, 2);
});

test("graph routing retries adapter ambiguity with exact-result extensions", async () => {
  const traceInputs: TraceProjectInput[] = [];
  let semanticCalls = 0;
  const graph = await searchProject(
    { projectPath: ".", query: "Feature.Target 호출자", mode: "auto" },
    {
      dependencies: {
        searchExact: async () => exactResult(true),
        searchSemantic: async () => {
          semanticCalls += 1;
          return semanticResult();
        },
        traceProject: async (input: TraceProjectInput) => {
          traceInputs.push(input);
          if (input.sourceFileExtensions === undefined) {
            throw new GraphTraceError(
              "Specify a language",
              "trace_language_required",
              ["fixture-csharp", "fixture-typescript"],
            );
          }
          return graphResult(true);
        },
      },
    },
  );

  assert.equal(graph.route, "graph");
  assert.equal(semanticCalls, 0);
  assert.equal(traceInputs.length, 2);
  assert.equal(traceInputs[0]?.sourceFileExtensions, undefined);
  assert.deepEqual(traceInputs[1]?.sourceFileExtensions, [".cs"]);
});

test("auto graph routing preserves unresolved adapter ambiguity", async () => {
  let semanticCalls = 0;
  await assert.rejects(
    searchProject(
      { projectPath: ".", query: "Feature.Target 호출자", mode: "auto" },
      {
        dependencies: {
          searchExact: async () => exactResult(false),
          searchSemantic: async () => {
            semanticCalls += 1;
            return semanticResult();
          },
          traceProject: async () => {
            throw new GraphTraceError(
              "Specify a language",
              "trace_language_required",
              ["fixture-csharp", "fixture-typescript"],
            );
          },
        },
      },
    ),
    (error: unknown) =>
      error instanceof GraphTraceError &&
      error.code === "trace_language_required",
  );
  assert.equal(semanticCalls, 0);
});

test("auto mode falls back for a missing graph symbol or trace adapter", async () => {
  const baseDependencies = {
    searchExact: async () => exactResult(false),
    searchSemantic: async () => semanticResult(),
  };
  const fallback = await searchProject(
    { projectPath: ".", query: "Missing.Target 호출자", mode: "auto" },
    {
      dependencies: {
        ...baseDependencies,
        traceProject: async () => {
          throw new GraphTraceError("not found", "symbol_not_found");
        },
      },
    },
  );
  assert.equal(fallback.route, "semantic");
  assert.equal(fallback.fallbackUsed, true);

  const unavailable = await searchProject(
    { projectPath: ".", query: "Feature.Target 호출자", mode: "auto" },
    {
      dependencies: {
        ...baseDependencies,
        traceProject: async () => {
          throw new GraphTraceError("adapter unavailable", "adapter_unavailable");
        },
      },
    },
  );
  assert.equal(unavailable.route, "semantic");
  assert.equal(unavailable.fallbackUsed, true);

  await assert.rejects(
    searchProject(
      { projectPath: ".", query: "호출 관계", mode: "graph" },
      {
        dependencies: {
          ...baseDependencies,
          traceProject: async () => graphResult(false),
        },
      },
    ),
    (error: unknown) =>
      error instanceof HybridSearchError && error.code === "invalid_graph_query",
  );

  await assert.rejects(
    searchProject(
      {
        projectPath: ".",
        query: "Feature",
        mode: "auto",
        maxResults: 1.5,
      },
      {
        dependencies: {
          ...baseDependencies,
          traceProject: async () => graphResult(false),
        },
      },
    ),
    (error: unknown) =>
      error instanceof HybridSearchError && error.code === "invalid_request",
  );
});
