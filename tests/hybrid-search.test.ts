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
import type { GraphRagSearchResult } from "../src/graphrag-search.js";
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

function graphRagResult(): GraphRagSearchResult {
  return {
    ...semanticResult(),
    route: "graphrag",
    graph: {
      languages: ["fixture"],
      seedNodes: 1,
      expandedNodes: 1,
      hops: 2,
      staleNodesSkipped: 0,
      staleEdgesSkipped: 0,
      truncated: false,
    },
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
  assert.equal(extractGraphDirection("IFeature 구현 타입"), "implementedBy");
});

test("graph direction reads Korean particles against the traced symbol", () => {
  const cases: Array<[string, string, string]> = [
    ["PlayerController.HasFlag 를 호출하는 곳", "PlayerController.HasFlag", "callers"],
    ["PlayerController.HasFlag 어디서 호출돼?", "PlayerController.HasFlag", "callers"],
    ["PlayerController.HasFlag 호출하는 메서드", "PlayerController.HasFlag", "callers"],
    ["누가 PlayerController.HasFlag 호출해?", "PlayerController.HasFlag", "callers"],
    ["PlayerController.HasFlag 를 부르는 곳", "PlayerController.HasFlag", "callers"],
    ["PlayerController.HasFlag 사용처", "PlayerController.HasFlag", "callers"],
    ["PlayerController.HasFlag 호출자", "PlayerController.HasFlag", "callers"],
    ["누가 호출 PlayerController.HasFlag", "PlayerController.HasFlag", "callers"],
    ["PlayerController.HasFlag 를 어디서 참조해?", "PlayerController.HasFlag", "callers"],
    ["PlayerController.HasFlag 가 호출하는 메서드", "PlayerController.HasFlag", "callees"],
    ["PlayerController.HasFlag에서 호출되는 메서드", "PlayerController.HasFlag", "callees"],
    ["Feature.Target 는 누가 호출해?", "Feature.Target", "callers"],
    ["Feature.Target 는 무엇을 호출해?", "Feature.Target", "callees"],
    ["Feature.Target 가 어느 메서드를 호출해?", "Feature.Target", "callees"],
    ["어느 파일에서 Feature.Target 를 참조해?", "Feature.Target", "callers"],
    ["Feature.Target 를 호출하는 하위 클래스", "Feature.Target", "callers"],
    ["어디서 Assets/UI/Slot.cs.meta 를 참조해?", "Assets/UI/Slot.cs.meta", "callers"],
    [
      "어디서 Assets/Scripts/UI/Inventory/InventorySlotItemView.cs.meta 를 참조해?",
      "Assets/Scripts/UI/Inventory/InventorySlotItemView.cs.meta",
      "callers",
    ],
    ["BaseState 를 상속하는 클래스", "BaseState", "derived"],
    ["BaseState 하위 클래스", "BaseState", "derived"],
    ["BaseState가 상속하는 클래스", "BaseState", "inherits"],
    ["IFeature를 구현하는 클래스", "IFeature", "implementedBy"],
    ["Player가 구현하는 인터페이스", "Player", "implements"],
    ["PlayerController가 어떤 클래스에 의존해?", "PlayerController", "callees"],
    ["PlayerController는 어디에 의존해?", "PlayerController", "callees"],
    ["Who calls Feature.Target?", "Feature.Target", "callers"],
    ["Which classes implement IFeature?", "IFeature", "implementedBy"],
    ["Which classes implement IFeature in Game.Core?", "IFeature", "implementedBy"],
    ["derived types of BaseState", "BaseState", "derived"],
    ["classes derived from BaseState", "BaseState", "derived"],
    ["What is BaseState derived from?", "BaseState", "inherits"],
    ["base types of Player", "Player", "inherits"],
  ];
  for (const [query, symbol, direction] of cases) {
    assert.deepEqual(
      decideSearchRoute(query, "all"),
      { route: "graph", symbol, direction },
      query,
    );
  }
  // Ordinary questions keep going to GraphRAG instead of an adapter trace.
  for (const query of [
    "What is the base class for UI panels?",
    "DOTween을 사용하는 방법",
    "How are HTTP calls retried?",
    "How do I extend InventoryView?",
  ]) {
    assert.equal(decideSearchRoute(query, "all").route, "semantic", query);
  }
});

test("an empty graph answer names the directions to try instead", async () => {
  const search = (query: string) => searchProject(
    { projectPath: ".", query, mode: "graph" },
    {
      dependencies: {
        searchExact: async () => exactResult(false),
        searchSemantic: async () => semanticResult(),
        traceProject: async (input: TraceProjectInput) => ({
          ...graphResult(false),
          symbol: input.symbol,
          direction: input.direction,
        }),
      },
    },
  );
  const calls = (await search("Feature.Target 가 호출하는 메서드")) as GraphTraceResult;
  assert.equal(calls.route, "graph");
  assert.match(calls.diagnostics.messages[0] ?? "", /No callees relationships were found for Feature\.Target/u);
  assert.match(calls.diagnostics.messages[0] ?? "", /direction "callers"\.$/u);

  const types = (await search("IRunnable 를 상속하는 인터페이스")) as GraphTraceResult;
  assert.match(types.diagnostics.messages[0] ?? "", /direction "inherits" or "implementedBy"\.$/u);
});

test("an adapter without a direction falls back in auto mode and fails in graph mode", async () => {
  let semanticCalls = 0;
  const dependencies = {
    searchExact: async () => exactResult(false),
    searchSemantic: async () => {
      semanticCalls += 1;
      return semanticResult();
    },
    traceProject: async () => {
      throw new GraphTraceError("no derived support", "unsupported_direction");
    },
  };
  const fallback = await searchProject(
    { projectPath: ".", query: "BaseState 를 상속하는 클래스", mode: "auto" },
    { dependencies },
  );
  assert.equal(fallback.fallbackUsed, true);
  assert.equal(semanticCalls, 1);
  await assert.rejects(
    searchProject(
      { projectPath: ".", query: "BaseState 를 상속하는 클래스", mode: "graph" },
      { dependencies },
    ),
    (error: unknown) => error instanceof GraphTraceError && error.code === "unsupported_direction",
  );
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

test("auto semantic routing uses GraphRAG when a fresh graph snapshot is available", async () => {
  let semanticCalls = 0;
  const result = await searchProject(
    { projectPath: ".", query: "how does the feature workflow work", mode: "auto" },
    {
      dependencies: {
        searchExact: async () => exactResult(false),
        searchSemantic: async () => {
          semanticCalls += 1;
          return semanticResult();
        },
        searchGraphRag: async () => graphRagResult(),
        traceProject: async () => graphResult(false),
      },
    },
  );
  assert.equal(result.route, "graphrag");
  assert.equal((result as GraphRagSearchResult).graph?.expandedNodes, 1);
  assert.equal(semanticCalls, 0);
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
