import assert from "node:assert/strict";
import test from "node:test";

import { MilvusRestClient } from "../src/milvus-rest-client.js";

test("MilvusRestClient creates an isolated cosine collection and parses hits", async () => {
  const endpoints: string[] = [];
  let hasCollection = false;
  const fetchMock: typeof fetch = async (input, init) => {
    const endpoint = new URL(input.toString()).pathname;
    endpoints.push(endpoint);
    const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (endpoint.endsWith("/collections/has")) {
      return Response.json({ code: 0, data: { has: hasCollection } });
    }
    if (endpoint.endsWith("/collections/create")) {
      assert.equal(request.metricType, "COSINE");
      assert.equal(request.primaryFieldName, "id");
      hasCollection = true;
      return Response.json({ code: 0, data: {} });
    }
    if (endpoint.endsWith("/collections/get_load_state")) {
      return Response.json({
        code: 0,
        data: { loadState: "LoadStateLoaded", loadProgress: 100 },
      });
    }
    if (endpoint.endsWith("/entities/search")) {
      return Response.json({
        code: 0,
        data: [
          {
            id: "a".repeat(64),
            distance: 0.91,
            source: "code",
            path: "src/Feature.cs",
            lineStart: 2,
            lineEnd: 8,
            content: "class Feature {}",
            fileHash: "b".repeat(64),
            indexedAt: "2026-07-14T00:00:00.000Z",
            commit: "",
          },
        ],
      });
    }
    throw new Error(`Unexpected endpoint ${endpoint}`);
  };
  const client = new MilvusRestClient(
    { address: "127.0.0.1:19530" },
    fetchMock,
  );

  await client.ensureCollection("pc_fixture_abc_v1", 3);
  const load = await client.getCollectionLoadState("pc_fixture_abc_v1");
  const hits = await client.search("pc_fixture_abc_v1", [0.1, 0.2, 0.3], 5);
  assert.deepEqual(load, { state: "LoadStateLoaded", progress: 100 });
  assert.equal(hits[0]?.path, "src/Feature.cs");
  assert.equal(hits[0]?.score, 0.91);
  assert.equal(hits[0]?.commit, null);
  assert.deepEqual(endpoints, [
    "/v2/vectordb/collections/has",
    "/v2/vectordb/collections/create",
    "/v2/vectordb/collections/get_load_state",
    "/v2/vectordb/entities/search",
  ]);
});
