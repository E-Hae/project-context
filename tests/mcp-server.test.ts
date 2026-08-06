import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createProjectContextServer } from "../src/mcp-server.js";
import { GraphTraceError } from "../src/graph-client.js";
import type { SemanticSearchResult } from "../src/result-format.js";
import { writeProjectConfig } from "./project-config-fixture.js";

test("context_search keeps the semantic route when GraphRAG metadata is present", async () => {
  let includeGraph = false;
  const semantic: SemanticSearchResult = {
    route: "semantic",
    fallbackUsed: false,
    query: "workflow",
    scope: "code",
    commit: null,
    indexCommit: null,
    indexedAt: "2026-08-05T00:00:00.000Z",
    stale: false,
    queryExpansion: { used: false, model: null, expandedQuery: null, identifierQuery: null, error: null },
    staleResultsSkipped: 0,
    results: [],
    truncated: false,
  };
  const server = createProjectContextServer({
    search: async () => includeGraph
      ? {
          ...semantic,
          graph: {
            languages: ["fixture"],
            seedNodes: 1,
            expandedNodes: 1,
            hops: 2,
            staleNodesSkipped: 0,
            staleEdgesSkipped: 0,
            truncated: false,
          },
        }
      : semantic,
  });
  const client = new Client({ name: "project-context-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    for (const expectedGraph of [false, true]) {
      includeGraph = expectedGraph;
      const response = await client.callTool({
        name: "context_search",
        arguments: { projectPath: ".", query: "workflow", mode: "auto" },
      });
      const content = response.structuredContent as { route?: unknown; graph?: unknown } | undefined;
      assert.equal(response.isError, undefined);
      assert.equal(content?.route, "semantic");
      assert.equal(content?.graph !== undefined, expectedGraph);
    }
  } finally {
    await client.close();
    await server.close();
  }
});

test("context_status is exposed through MCP and returns structured content", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "project-context-mcp-"));
  const handoffRoot = path.join(projectRoot, "handoff-fixture");
  const handoffProject = path.join(handoffRoot, "fixture-project");
  await mkdir(path.join(projectRoot, "src"));
  await mkdir(handoffProject, { recursive: true });
  await writeProjectConfig(
    projectRoot,
    "version: 1\nsources:\n  code: [src]\n  documents: []\n  handoff:\n    enabled: false\n",
  );
  await writeFile(
    path.join(projectRoot, "src", "Example.cs"),
    "first line\nNeedle line\nthird line\n",
    "utf8",
  );
  await writeFile(
    path.join(handoffProject, ".project-path"),
    `${projectRoot.replaceAll("\\", "/")}\n`,
    "utf8",
  );
  const handoffContent =
    "---\ntitle: Fixture handoff\ndate: 2026-07-14\n---\n\n# Fixture\nFull body\n";
  await writeFile(
    path.join(handoffProject, "notes_fixture.md"),
    handoffContent,
    "utf8",
  );
  const server = createProjectContextServer({
    handoffRoot,
    trace: async ({ projectPath, symbol, direction }) => ({
      route: "graph",
      fallbackUsed: false,
      symbol,
      direction,
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
        metadataFailures: 0,
        projectFilesRead: 0,
        assemblyDefinitionsLoaded: 0,
        referencesLoaded: 1,
        referenceFailures: 0,
        parseErrors: 0,
        unresolvedCandidates: 0,
        partial: false,
        elapsedMs: 1,
        messages: [projectPath],
      },
      results: [],
      truncated: false,
    }),
  });
  const client = new Client({ name: "project-context-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name),
      [
        "context_status",
        "context_search",
        "context_read",
        "context_trace",
        "context_impact",
        "context_handoff_list",
        "context_handoff_get",
        "context_handoff_save",
        "context_handoff_update",
      ],
    );

    const result = await client.callTool({
      name: "context_status",
      arguments: {
        projectPath: path.join(tmpdir(), "project-context-mcp-missing"),
      },
    });

    const structuredContent = result.structuredContent as
      | { status?: unknown }
      | undefined;

    assert.equal(result.isError, undefined);
    assert.equal(structuredContent?.status, "unavailable");

    const search = await client.callTool({
      name: "context_search",
      arguments: { projectPath: projectRoot, query: "Needle" },
    });
    const searchContent = search.structuredContent as
      | { results?: unknown[] }
      | undefined;
    assert.equal(search.isError, undefined);
    assert.equal(searchContent?.results?.length, 1);

    const read = await client.callTool({
      name: "context_read",
      arguments: {
        projectPath: projectRoot,
        path: "src/Example.cs",
        startLine: 2,
        endLine: 3,
      },
    });
    const readContent = read.structuredContent as
      | { text?: unknown; lineStart?: unknown; lineEnd?: unknown }
      | undefined;
    assert.equal(read.isError, undefined);
    assert.equal(readContent?.text, "Needle line\nthird line");
    assert.equal(readContent?.lineStart, 2);
    assert.equal(readContent?.lineEnd, 3);

    const trace = await client.callTool({
      name: "context_trace",
      arguments: {
        projectPath: projectRoot,
        symbol: "Feature.Target",
        direction: "callers",
      },
    });
    const traceContent = trace.structuredContent as
      | { route?: unknown; workerVersion?: unknown }
      | undefined;
    assert.equal(trace.isError, undefined);
    assert.equal(traceContent?.route, "graph");
    assert.equal(traceContent?.workerVersion, "fixture-worker/1.0");

    const handoffs = await client.callTool({
      name: "context_handoff_list",
      arguments: { projectPath: projectRoot },
    });
    const handoffList = handoffs.structuredContent as
      | { totalDocuments?: unknown; projects?: Array<{ documents?: unknown[] }> }
      | undefined;
    assert.equal(handoffs.isError, undefined);
    assert.equal(handoffList?.totalDocuments, 1);
    assert.equal(handoffList?.projects?.[0]?.documents?.length, 1);

    const handoff = await client.callTool({
      name: "context_handoff_get",
      arguments: {
        projectPath: projectRoot,
        label: "notes_fixture",
      },
    });
    const handoffDocument = handoff.structuredContent as
      | { content?: unknown; documentId?: unknown }
      | undefined;
    assert.equal(handoff.isError, undefined);
    assert.equal(handoffDocument?.content, handoffContent);
    assert.equal(handoffDocument?.documentId, "fixture-project/notes_fixture");

    const saved = await client.callTool({
      name: "context_handoff_save",
      arguments: {
        projectPath: projectRoot,
        label: "analysis_created",
        content:
          "---\ntitle: Created through MCP\ndate: 2026-07-15\n---\n\n# Created through MCP\nBody\n",
      },
    });
    const savedDocument = saved.structuredContent as
      | { operation?: unknown; documentId?: unknown }
      | undefined;
    assert.equal(saved.isError, undefined);
    assert.equal(savedDocument?.operation, "created");
    assert.equal(savedDocument?.documentId, "fixture-project/analysis_created");

    const updated = await client.callTool({
      name: "context_handoff_update",
      arguments: {
        projectPath: projectRoot,
        label: "analysis_created",
        mode: "append",
        content: "## Follow-up\nAppended body\n",
      },
    });
    const updatedDocument = updated.structuredContent as
      | { operation?: unknown; content?: unknown }
      | undefined;
    assert.equal(updated.isError, undefined);
    assert.equal(updatedDocument?.operation, "appended");
    assert.equal(
      updatedDocument?.content,
      "---\ntitle: Created through MCP\ndate: 2026-07-15\n---\n\n# Created through MCP\nBody\n## Follow-up\nAppended body\n",
    );
  } finally {
    await client.close();
    await server.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("context_trace returns a trace language selection error to MCP callers", async () => {
  const server = createProjectContextServer({
    trace: async () => {
      throw new GraphTraceError("Specify a language", "trace_language_required");
    },
  });
  const client = new Client({ name: "project-context-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({
      name: "context_trace",
      arguments: {
        projectPath: ".",
        symbol: "Feature.Target",
        direction: "callers",
        language: "python",
      },
    });
    assert.equal(result.isError, true);
    const content = result.content as Array<{ text?: string }>;
    assert.match(content[0]?.text ?? "", /Specify a language/);
  } finally {
    await client.close();
    await server.close();
  }
});

test("context_search forwards an optional graph language", async () => {
  let receivedLanguage: string | undefined;
  const server = createProjectContextServer({
    search: async (input) => {
      receivedLanguage = input.language;
      return {
        route: "exact",
        fallbackUsed: false,
        query: input.query,
        scope: input.scope ?? "all",
        commit: null,
        indexedAt: null,
        results: [],
        truncated: false,
      };
    },
  });
  const client = new Client({ name: "project-context-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({
      name: "context_search",
      arguments: {
        projectPath: ".",
        query: "Feature.Target 호출자",
        mode: "graph",
        language: "csharp",
      },
    });
    assert.equal(result.isError, undefined);
    assert.equal(receivedLanguage, "csharp");
  } finally {
    await client.close();
    await server.close();
  }
});
