import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { searchExact } from "../src/exact-search.js";
import { withGitConfigHome } from "./git-config-fixture.js";
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

test("searchExact orders evidence by target, then by directory entry names", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-context-search-order-"));
  try {
    await mkdir(path.join(root, "src", "a"), { recursive: true });
    await mkdir(path.join(root, "lib"), { recursive: true });
    await writeProjectConfig(root, "version: 1\nsources:\n  code: [src, lib]\n  documents: []\n");
    await writeFile(path.join(root, "src", "a.cs"), "Needle\n", "utf8");
    await writeFile(path.join(root, "src", "a", "z.cs"), "Needle\nNeedle\n", "utf8");
    await writeFile(path.join(root, "src", "B.cs"), "Needle\n", "utf8");
    await writeFile(path.join(root, "lib", "0.cs"), "Needle\n", "utf8");

    // Targets keep their configured order; inside one, a directory's entries
    // sort by name, so "a/" comes before "a.cs" and "B" before "a".
    const all = await searchExact({ projectPath: root, query: "Needle" });
    assert.deepEqual(all.results.map((item) => `${item.path}:${item.lineStart}`), [
      "src/B.cs:1",
      "src/a/z.cs:1",
      "src/a/z.cs:2",
      "src/a.cs:1",
      "lib/0.cs:1",
    ]);
    assert.equal(all.truncated, false);

    const limited = await searchExact({ projectPath: root, query: "Needle", maxResults: 2 });
    assert.deepEqual(limited.results.map((item) => `${item.path}:${item.lineStart}`), [
      "src/B.cs:1",
      "src/a/z.cs:1",
    ]);
    assert.equal(limited.truncated, true);

    const paths = await searchExact({ projectPath: root, query: "src/" });
    assert.deepEqual(paths.results.map((item) => item.path), ["src/B.cs", "src/a/z.cs", "src/a.cs"]);
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

test("searchExact skips binary files and decodes byte-order marks", async () => {
  const root = await createFixture();
  try {
    await writeFile(path.join(root, "src", "Binary.cs"), "Needle binary\0\n");
    await writeFile(
      path.join(root, "src", "Bom.cs"),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("Needle bom\r\nx\r\n")]),
    );
    await writeFile(
      path.join(root, "src", "Utf16.cs"),
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("x\nNeedle utf16\n", "utf16le")]),
    );
    await writeFile(
      path.join(root, "src", "Utf16Be.cs"),
      Buffer.concat([
        Buffer.from([0xfe, 0xff]),
        Buffer.from("Needle be\n", "utf16le").swap16(),
      ]),
    );

    const result = await searchExact({ projectPath: root, query: "Needle", scope: "code" });
    assert.deepEqual(
      result.results.map((item) => [item.path, item.lineStart, item.text]),
      [
        ["src/Bom.cs", 1, "Needle bom"],
        ["src/Feature.cs", 1, "Needle first"],
        ["src/Feature.cs", 3, "Needle second"],
        ["src/Utf16.cs", 2, "Needle utf16"],
        ["src/Utf16Be.cs", 1, "Needle be"],
      ],
    );

    // Path search lists a binary file; only content search skips it.
    const paths = await searchExact({ projectPath: root, query: "src/Binary.cs" });
    assert.deepEqual(paths.results.map((item) => item.path), ["src/Binary.cs"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("searchExact bounds the text of a very long matching line", async () => {
  const root = await createFixture();
  try {
    await writeFile(
      path.join(root, "src", "Long.cs"),
      `${"x".repeat(3 * 1024 * 1024)}Needle\nNeedle short\n`,
      "utf8",
    );
    const result = await searchExact({ projectPath: root, query: "Needle", scope: "code" });
    const long = result.results.filter((item) => item.path === "src/Long.cs");
    assert.deepEqual(long.map((item) => [item.lineStart, item.text.length]), [
      [1, 2_000],
      [2, "Needle short".length],
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("searchExact searches explicitly configured files whatever their extension", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-context-search-"));
  try {
    await writeProjectConfig(
      root,
      "version: 1\nsources:\n  code: []\n  documents: [LICENSE]\n",
    );
    await writeFile(path.join(root, "LICENSE"), "MIT Needle\n", "utf8");
    const result = await searchExact({ projectPath: root, query: "Needle" });
    assert.deepEqual(
      result.results.map((item) => [item.source, item.path, item.lineStart]),
      [["document", "LICENSE", 1]],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("searchExact honors .gitignore inside a repository", async () => {
  const root = await createFixture();
  try {
    await mkdir(path.join(root, ".git"));
    await mkdir(path.join(root, "src", "cache"));
    await writeFile(path.join(root, ".gitignore"), "/src/cache/\n", "utf8");
    await writeFile(path.join(root, "src", "cache", "Cached.cs"), "Needle cached\n", "utf8");
    const result = await withGitConfigHome(path.join(root, "no-home"), () =>
      searchExact({ projectPath: root, query: "Needle", scope: "code" }));
    assert.deepEqual(
      result.results.map((item) => item.path),
      ["src/Feature.cs", "src/Feature.cs"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("searchExact rejects multi-line content queries and reports timeouts", async () => {
  const root = await createFixture();
  try {
    await assert.rejects(
      searchExact({ projectPath: root, query: "Needle\nfirst" }),
      /must not contain a line break/,
    );
    for (let index = 0; index < 300; index += 1) {
      await mkdir(path.join(root, "src", `dir${index}`));
    }
    await assert.rejects(
      searchExact({ projectPath: root, query: "Needle", timeoutMs: 1 }),
      /Exact search timed out after 1ms/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
