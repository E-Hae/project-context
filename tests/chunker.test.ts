import assert from "node:assert/strict";
import test from "node:test";

import { chunkDocument } from "../src/chunker.js";

test("chunkDocument prefers Markdown heading boundaries", () => {
  const chunks = chunkDocument({
    path: "docs/design.md",
    text: "# Design\nintro\n## Runtime\nrun details\n## Storage\nstore details\n",
    targetCharacters: 24,
    maxCharacters: 40,
  });

  assert.deepEqual(
    chunks.map((chunk) => [chunk.lineStart, chunk.lineEnd, chunk.text]),
    [
      [1, 2, "# Design\nintro"],
      [3, 4, "## Runtime\nrun details"],
      [5, 6, "## Storage\nstore details"],
    ],
  );
});

test("chunkDocument prefers C# declaration boundaries", () => {
  const chunks = chunkDocument({
    path: "src/Feature.cs",
    text: [
      "namespace Demo;",
      "public class Feature",
      "{",
      "    public void First()",
      "    {",
      "        Run();",
      "    }",
      "    public void Second()",
      "    {",
      "        Stop();",
      "    }",
      "}",
    ].join("\n"),
    targetCharacters: 60,
    maxCharacters: 100,
  });

  assert.equal(chunks.length, 3);
  assert.equal(chunks[1]?.lineStart, 4);
  assert.match(chunks[1]?.text ?? "", /First/);
  assert.equal(chunks[2]?.lineStart, 8);
  assert.match(chunks[2]?.text ?? "", /Second/);

  const fineGrained = chunkDocument({
    path: "src/Feature.cs",
    text: "public void Run()\n{\n    Execute();\n    Stop();\n}\n",
    targetCharacters: 1,
    maxCharacters: 100,
  });
  assert.deepEqual(fineGrained.map((chunk) => chunk.lineStart), [1]);
});

test("chunkDocument splits a long single line without losing its evidence line", () => {
  const chunks = chunkDocument({
    path: "data.json",
    text: "x".repeat(25),
    targetCharacters: 10,
    maxCharacters: 10,
  });

  assert.deepEqual(
    chunks.map((chunk) => [chunk.lineStart, chunk.lineEnd, chunk.text.length]),
    [
      [1, 1, 10],
      [1, 1, 10],
      [1, 1, 5],
    ],
  );
});
