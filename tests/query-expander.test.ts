import assert from "node:assert/strict";
import test from "node:test";

import { OllamaQueryExpander } from "../src/query-expander.js";

test("OllamaQueryExpander returns bounded deterministic retrieval text", async () => {
  const fetchMock: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.equal(request.think, false);
    assert.deepEqual(request.options, { temperature: 0, seed: 0, num_predict: 180 });
    return Response.json({
      response: JSON.stringify({
        englishQuery: "quest objective auto movement",
        codeTerms: ["QuestManager", "AutoMove", "ObjectiveState"],
      }),
    });
  };
  const expander = new OllamaQueryExpander(
    {
      url: "http://localhost:11434",
      embeddingModel: "nomic",
      queryExpansionModel: "qwen",
    },
    fetchMock,
  );

  const result = await expander.expand("퀘스트 자동 이동은?");
  assert.equal(
    result.retrievalQuery,
    "quest objective auto movement QuestManager AutoMove ObjectiveState",
  );
});
