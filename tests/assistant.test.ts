import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  askProject,
  formatAssistantAnswer,
  OllamaAnswerGenerator,
} from "../src/assistant.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { HybridSearchResult } from "../src/hybrid-search.js";

function exactResult(): HybridSearchResult {
  return {
    route: "exact",
    fallbackUsed: false,
    query: "where is session restore?",
    scope: "code",
    commit: null,
    indexedAt: null,
    results: [
      {
        source: "code",
        path: "src/Session.cs",
        matchKind: "content",
        lineStart: 10,
        lineEnd: 10,
        text: "RestoreSession();",
        score: null,
        indexedAt: null,
        commit: null,
      },
    ],
    truncated: false,
  };
}

async function createProject(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "project-context-assistant-"));
  await mkdir(path.join(root, "src"));
  await writeFile(
    path.join(root, ".project-context.yml"),
    "version: 1\nsources:\n  code: [src]\n  documents: []\n",
    "utf8",
  );
  await writeFile(
    path.join(root, "src", "Session.cs"),
    Array.from({ length: 30 }, (_, index) =>
      index === 9 ? "RestoreSession();" : `// line ${index + 1}`,
    ).join("\n"),
    "utf8",
  );
  return root;
}

test("askProject generates an answer only from bounded, source-verified code", async () => {
  const root = await createProject();
  try {
    let prompt = "";
    const result = await askProject(
      { projectPath: root, question: "세션 복구는 어디에서 실행되나요?" },
      {
        dependencies: {
          searchProject: async (input) => {
            assert.equal(input.projectPath, root);
            assert.equal(input.mode, "auto");
            assert.equal(input.scope, "code");
            assert.equal(input.maxResults, 20);
            return exactResult();
          },
          createAnswerGenerator: () => ({
            model: "fixture-model",
            async generate(value) {
              prompt = value;
              return "세션 복구는 RestoreSession 호출에서 시작됩니다. [S1]";
            },
          }),
        },
      },
    );

    assert.equal(result.citationValidation, "verified");
    assert.equal(result.model, "fixture-model");
    assert.equal(result.sources.length, 1);
    assert.equal(result.sources[0]?.path, "src/Session.cs");
    assert.equal(result.sources[0]?.lineStart, 2);
    assert.equal(result.sources[0]?.lineEnd, 18);
    assert.match(prompt, /<source id="S1" path="src\/Session\.cs" lines="2-18">/);
    assert.match(prompt, /RestoreSession\(\);/);
    assert.match(formatAssistantAnswer(result), /\[S1\] src\/Session\.cs:2-18/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("askProject suppresses an uncited model answer while retaining verified sources", async () => {
  const root = await createProject();
  try {
    const result = await askProject(
      { projectPath: root, question: "where is session restore?" },
      {
        dependencies: {
          searchProject: async () => exactResult(),
          createAnswerGenerator: () => ({
            model: "fixture-model",
            async generate() {
              return "Session restore happens here.";
            },
          }),
        },
      },
    );

    assert.equal(result.citationValidation, "failed");
    assert.match(result.answer, /인용을 검증하지 못해/);
    assert.equal(result.sources.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("OllamaAnswerGenerator uses the configured local answer model", async () => {
  let request: RequestInit | undefined;
  const generator = new OllamaAnswerGenerator(
    { ...DEFAULT_CONFIG.services.ollama, answerModel: "fixture-answer" },
    async (_input, init) => {
      request = init;
      return new Response(JSON.stringify({ response: "Verified answer [S1]" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  );

  const answer = await generator.generate("prompt");

  assert.equal(answer, "Verified answer [S1]");
  const requestBody = JSON.parse(String(request?.body)) as Record<string, unknown>;
  assert.match(String(requestBody.system), /source-grounded project code assistant/);
  delete requestBody.system;
  assert.deepEqual(requestBody, {
    model: "fixture-answer",
    prompt: "prompt",
    stream: false,
    think: false,
    options: { temperature: 0, seed: 0, num_predict: 900 },
    keep_alive: "10m",
  });
});
