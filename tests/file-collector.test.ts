import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { DEFAULT_CONFIG } from "../src/config.js";
import {
  collectProjectFiles,
  readIndexableFile,
} from "../src/file-collector.js";
import { resolveSourceTargets } from "../src/source-policy.js";

test("collectProjectFiles returns configured UTF-8 text files without duplicates", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-context-files-"));
  try {
    await mkdir(path.join(root, "src", "nested"), { recursive: true });
    await mkdir(path.join(root, "src", "generated"), { recursive: true });
    await writeFile(path.join(root, "src", "nested", "Feature.cs"), "class A {}\n");
    await writeFile(path.join(root, "src", "generated", "Generated.cs"), "class G {}\n");
    await writeFile(path.join(root, "src", "image.png"), "not indexed\n");
    const config = {
      ...DEFAULT_CONFIG,
      sources: {
        ...DEFAULT_CONFIG.sources,
        code: ["src", "src/nested"],
        documents: [],
      },
      exclude: ["src/generated/**"],
    };
    const targets = await resolveSourceTargets(root, config, "all");
    const files = await collectProjectFiles(root, targets, config.exclude);

    assert.deepEqual(files.map((file) => file.relativePath), ["src/nested/Feature.cs"]);
    const read = await readIndexableFile(root, files[0]!);
    assert.equal(read.kind, "ok");
    if (read.kind === "ok") {
      assert.equal(read.text, "class A {}\n");
      assert.equal(read.encoding, "utf-8");
      assert.match(read.hash, /^[a-f0-9]{64}$/);
    }

    const legacyPath = path.join(root, "src", "Legacy.cs");
    await writeFile(
      legacyPath,
      Buffer.concat([
        Buffer.from("// ", "ascii"),
        Buffer.from([0xc7, 0xd1, 0xb1, 0xdb]),
        Buffer.from("\nclass Legacy {}\n", "ascii"),
      ]),
    );
    const legacy = await readIndexableFile(root, {
      source: "code",
      absolutePath: legacyPath,
      relativePath: "src/Legacy.cs",
    });
    assert.equal(legacy.kind, "ok");
    if (legacy.kind === "ok") {
      assert.equal(legacy.encoding, "euc-kr");
      assert.match(legacy.text, /한글/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
