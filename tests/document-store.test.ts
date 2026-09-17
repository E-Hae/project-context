import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { readProjectDocument } from "../src/document-store.js";
import { writeProjectConfig } from "./project-config-fixture.js";

test("readProjectDocument reads an exact configured line range", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-context-read-"));
  try {
    await mkdir(path.join(root, "src", "generated"), { recursive: true });
    await writeProjectConfig(
      root,
      "version: 1\nsources:\n  code: [src]\n  documents: []\nexclude:\n  - src/generated/**\n",
    );
    await writeFile(
      path.join(root, "src", "Feature.cs"),
      "one\r\ntwo\r\nthree\r\nfour\r\n",
      "utf8",
    );
    await writeFile(
      path.join(root, "src", "generated", "Generated.cs"),
      "generated\n",
      "utf8",
    );

    const result = await readProjectDocument({
      projectPath: root,
      path: "src/Feature.cs",
      startLine: 2,
      endLine: 3,
    });
    assert.equal(result.source, "code");
    assert.equal(result.matchKind, "content");
    assert.equal(result.path, "src/Feature.cs");
    assert.equal(result.text, "two\nthree");
    assert.equal(result.lineStart, 2);
    assert.equal(result.lineEnd, 3);

    await assert.rejects(
      readProjectDocument({
        projectPath: root,
        path: "src/generated/Generated.cs",
      }),
      /excluded by project configuration/,
    );
    await assert.rejects(
      readProjectDocument({ projectPath: root, path: "../outside.cs" }),
      /escapes the project root/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readProjectDocument defaults to 100 lines and continues without overlap", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-context-read-window-"));
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeProjectConfig(
      root,
      "version: 1\nsources:\n  code: [src]\n  documents: []\nexclude: []\n",
    );
    const contents = Array.from({ length: 250 }, (_, index) => `line-${index + 1}`).join("\n");
    await writeFile(path.join(root, "src", "Large.cs"), contents, "utf8");

    const first = await readProjectDocument({
      projectPath: root,
      path: "src/Large.cs",
    });
    const second = await readProjectDocument({
      projectPath: root,
      path: "src/Large.cs",
      startLine: first.lineEnd + 1,
    });
    const explicitMaximum = await readProjectDocument({
      projectPath: root,
      path: "src/Large.cs",
      startLine: 1,
      endLine: 200,
    });

    assert.equal(first.lineStart, 1);
    assert.equal(first.lineEnd, 100);
    assert.equal(first.requestedEndLine, 100);
    assert.equal(first.hasMore, true);
    assert.equal(first.nextStartLine, 101);
    assert.equal(first.text.split("\n").at(-1), "line-100");
    assert.equal(second.lineStart, 101);
    assert.equal(second.lineEnd, 200);
    assert.equal(second.requestedEndLine, 200);
    assert.equal(second.text.split("\n")[0], "line-101");
    assert.equal(explicitMaximum.lineEnd, 200);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readProjectDocument enforces line and character limits", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-context-read-limits-"));
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeProjectConfig(
      root,
      "version: 1\nsources:\n  code: [src]\n  documents: []\nexclude: []\n",
    );
    await writeFile(path.join(root, "src", "Long.cs"), "x".repeat(50_001), "utf8");
    await writeFile(
      path.join(root, "src", "Bounded.cs"),
      `${"a".repeat(25_000)}\n${"b".repeat(24_999)}\nc`,
      "utf8",
    );

    await assert.rejects(
      readProjectDocument({
        projectPath: root,
        path: "src/Long.cs",
        startLine: 1,
        endLine: 201,
      }),
      /limited to 200 lines/,
    );
    await assert.rejects(
      readProjectDocument({ projectPath: root, path: "src/Long.cs" }),
      /Line 1 exceeds 50000 characters/,
    );
    const bounded = await readProjectDocument({
      projectPath: root,
      path: "src/Bounded.cs",
    });
    assert.equal(bounded.text.length, 50_000);
    assert.equal(bounded.lineEnd, 2);
    assert.equal(bounded.requestedEndLine, 100);
    assert.equal(bounded.hasMore, true);
    assert.equal(bounded.nextStartLine, 3);
    const remainder = await readProjectDocument({
      projectPath: root,
      path: "src/Bounded.cs",
      startLine: bounded.nextStartLine,
    });
    assert.equal(remainder.lineStart, 3);
    assert.equal(remainder.text, "c");
    assert.equal(remainder.hasMore, false);
    assert.equal(remainder.nextStartLine, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
