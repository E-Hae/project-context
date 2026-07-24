import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { traceAdapter } from "../src/index.js";

test("Unity adapter follows prefab GUID references through meta files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-context-unity-"));
  try {
    const prefab = "Assets/Prefabs/Player.prefab";
    const asset = "Assets/Data/PlayerConfig.asset";
    const meta = "Assets/Data/PlayerConfig.asset.meta";
    await mkdir(path.join(root, "Assets/Prefabs"), { recursive: true });
    await mkdir(path.join(root, "Assets/Data"), { recursive: true });
    await writeFile(path.join(root, prefab), "%YAML 1.1\n--- !u!1 &1\nGameObject:\n  m_Config: {fileID: 11400000, guid: 0123456789abcdef0123456789abcdef, type: 2}\n", "utf8");
    await writeFile(path.join(root, asset), "%YAML 1.1\n--- !u!114 &1\nMonoBehaviour:\n", "utf8");
    await writeFile(path.join(root, meta), "fileFormatVersion: 2\nguid: 0123456789abcdef0123456789abcdef\n", "utf8");

    const result = await traceAdapter.trace({
      projectRoot: root,
      files: [prefab, asset, meta],
      auxiliaryFiles: [],
      symbol: prefab,
      direction: "callees",
      maxResults: 10,
      adapterConfig: { unity: { mode: "yaml", editorVersion: null, batchTimeoutSeconds: 120 } },
    });

    assert.equal(result.matchedSymbols[0]?.path, prefab);
    assert.equal(result.results[0]?.to.path, asset);
    assert.equal(result.results[0]?.evidence.lineStart, 4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
