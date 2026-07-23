import assert from "node:assert/strict";
import test from "node:test";

import { OllamaEmbeddingClient } from "../src/embedding-client.js";

test("OllamaEmbeddingClient applies Nomic retrieval prefixes", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const fetchMock: typeof fetch = async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(
      JSON.stringify({ model: "nomic", embeddings: [[0.1, 0.2, 0.3]] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const client = new OllamaEmbeddingClient(
    {
      url: "http://localhost:11434/prefix",
      embeddingModel: "nomic",
      queryExpansionModel: null,
    },
    fetchMock,
  );

  assert.deepEqual(await client.embedQuery("where is storage?"), [0.1, 0.2, 0.3]);
  assert.deepEqual(requests[0]?.input, ["search_query: where is storage?"]);
  assert.equal(requests[0]?.truncate, false);
});

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
