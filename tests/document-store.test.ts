import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { readProjectDocument } from "../src/document-store.js";

test("readProjectDocument reads an exact configured line range", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-context-read-"));
  try {
    await mkdir(path.join(root, "src", "generated"), { recursive: true });
    await writeFile(
      path.join(root, ".project-context.yml"),
      "version: 1\nsources:\n  code: [src]\n  documents: []\nexclude:\n  - src/generated/**\n",
      "utf8",
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
