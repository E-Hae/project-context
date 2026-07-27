import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { searchExact } from "../src/exact-search.js";
import { writeProjectConfig } from "./project-config-fixture.js";

async function createFixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "project-context-search-"));
  await mkdir(path.join(root, "src", "generated"), { recursive: true });
  await mkdir(path.join(root, "docs"), { recursive: true });
  await writeProjectConfig(
    root,
    [
      "version: 1",
      "sources:",
      "  code: [src]",
      "  documents: [docs]",
      "  handoff:",
      "    enabled: false",
      "exclude:",
      "  - src/generated/**",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(root, "src", "Feature.cs"),
    "Needle first\nno match\nNeedle second\n-Nee dle\n",
    "utf8",
  );
  await writeFile(
    path.join(root, "src", "generated", "Generated.cs"),
    "Needle generated\n",
    "utf8",
  );
  await writeFile(path.join(root, "docs", "design.md"), "Needle design\n", "utf8");
  return root;
}

test("searchExact returns deterministic evidence and honors scope/excludes", async () => {
  const root = await createFixture();
  try {
    const result = await searchExact({ projectPath: root, query: "Needle" });

    assert.equal(result.route, "exact");
    assert.equal(result.fallbackUsed, false);
    assert.deepEqual(
      result.results.map((item) => [item.source, item.path, item.lineStart]),
      [
        ["code", "src/Feature.cs", 1],
        ["code", "src/Feature.cs", 3],
        ["document", "docs/design.md", 1],
      ],
    );
    assert.equal(result.results.some((item) => item.path.includes("generated")), false);
    assert.equal(result.results.every((item) => item.matchKind === "content"), true);

    const documents = await searchExact({
      projectPath: root,
      query: "Needle",
      scope: "documents",
    });
    assert.deepEqual(documents.results.map((item) => item.path), ["docs/design.md"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("searchExact finds known file paths without treating them as patterns", async () => {
  const root = await createFixture();
  try {
    const result = await searchExact({
      projectPath: root,
      query: "Feature.cs",
    });
    assert.deepEqual(result.results, [
      {
        source: "code",
        path: "src/Feature.cs",
        matchKind: "path",
        lineStart: null,
        lineEnd: null,
        text: "src/Feature.cs",
        score: null,
        indexedAt: null,
        commit: null,
      },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("searchExact caps global results and reports truncation", async () => {
  const root = await createFixture();
  try {
    await writeFile(
      path.join(root, "src", "Burst.cs"),
      Array.from({ length: 5_000 }, (_, index) => `Needle ${index}`).join("\n"),
      "utf8",
    );
    const result = await searchExact({
      projectPath: root,
      query: "Needle",
      maxResults: 1,
    });
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]?.path, "src/Burst.cs");
    assert.equal(result.results[0]?.lineStart, 1);
    assert.equal(result.truncated, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("searchExact de-duplicates evidence from overlapping source roots", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-context-search-"));
  try {
    await mkdir(path.join(root, "src", "nested"), { recursive: true });
    await writeProjectConfig(
      root,
      "version: 1\nsources:\n  code: [src, src/nested]\n  documents: []\n",
    );
    await writeFile(
      path.join(root, "src", "nested", "Feature.cs"),
      "Needle once\n",
      "utf8",
    );

    const result = await searchExact({ projectPath: root, query: "Needle" });
    assert.deepEqual(
      result.results.map((item) => [item.path, item.lineStart]),
      [["src/nested/Feature.cs", 1]],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("searchExact requires project config and rejects escaping source paths", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-context-search-"));
  try {
    await assert.rejects(
      searchExact({ projectPath: root, query: "Needle" }),
      /Project config not found/,
    );
    await writeProjectConfig(
      root,
      "version: 1\nsources:\n  code: [../]\n",
    );
    await assert.rejects(
      searchExact({ projectPath: root, query: "Needle" }),
      /escapes the project root/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
