import assert from "node:assert/strict";
import test from "node:test";

import { OllamaEmbeddingClient } from "../src/embedding-client.js";

for (const profile of [
  {
    models: ["nomic-embed-text", "nomic-embed-text:v1.5"],
    query: "search_query: where is storage?",
    documentPrefix: "search_document: ",
  },
  {
    models: ["qwen3-embedding", "qwen3-embedding:0.6b", "qwen3-embedding:4b"],
    query:
      "Instruct: Given a code search query, retrieve relevant code snippets or documentation that answer the query.\nQuery:where is storage?",
    documentPrefix: "",
  },
  {
    models: ["other-embedding:latest"],
    query: "where is storage?",
    documentPrefix: "",
  },
]) {
  for (const model of profile.models) {
    test(`OllamaEmbeddingClient formats queries, documents and probes for ${model}`, async () => {
      const requests: Array<Record<string, unknown>> = [];
      const fetchMock: typeof fetch = async (_input, init) => {
        requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(
          JSON.stringify({
            model,
            embeddings: (requests.at(-1)!.input as string[]).map(() => [0.1, 0.2, 0.3]),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      };
      const client = new OllamaEmbeddingClient(
        {
          url: "http://localhost:11434/prefix",
          embeddingModel: model,
          queryExpansionModel: null,
        },
        fetchMock,
      );

      assert.deepEqual(await client.embedQuery("where is storage?"), [0.1, 0.2, 0.3]);
      assert.deepEqual(requests[0]?.input, [profile.query]);
      assert.equal(requests[0]?.truncate, false);
      await client.embedDocuments(["storage code", "저장소 문서"]);
      assert.deepEqual(requests[1]?.input, [
        `${profile.documentPrefix}storage code`,
        `${profile.documentPrefix}저장소 문서`,
      ]);
      assert.equal(await client.probeDimension(), 3);
      assert.deepEqual(requests[2]?.input, [
        `${profile.documentPrefix}project context dimension probe`,
      ]);
    });
  }
}

test("OllamaEmbeddingClient rejects a response from a different model", async () => {
  const client = new OllamaEmbeddingClient(
    {
      url: "http://localhost:11434",
      embeddingModel: "expected-model",
      queryExpansionModel: null,
    },
    async () =>
      Response.json({ model: "different-model", embeddings: [[0.1, 0.2]] }),
  );

  await assert.rejects(client.embedQuery("query"), /expected expected-model/);
});
