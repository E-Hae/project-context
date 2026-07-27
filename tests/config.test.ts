import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_CONFIG,
  PROJECT_CONFIG_FILENAME,
  loadProjectConfig,
} from "../src/config.js";

test("loadProjectConfig returns defaults when the file is missing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-context-config-"));
  try {
    const loaded = await loadProjectConfig(root);

    assert.equal(loaded.exists, false);
    assert.equal(loaded.valid, true);
    assert.deepEqual(loaded.value, DEFAULT_CONFIG);
    assert.equal(loaded.value.sources.handoff.enabled, false);
    assert.deepEqual(loaded.value.sources.semanticExclude, []);
    assert.equal(loaded.value.services.vectorStore.backend, "local");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loadProjectConfig validates and merges a project config", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-context-config-"));
  try {
    await writeFile(
      path.join(root, PROJECT_CONFIG_FILENAME),
      [
        "version: 1",
        "sources:",
        "  code: [Assets/Scripts]",
        "  semanticExclude: [Assets/Scripts/Generated/**]",
        "  handoff:",
        "    projectSlug: example-project",
        "exclude: [Library/**]",
        "services:",
        "  milvus:",
        "    address: localhost:19530",
        "adapters:",
        "  unity:",
        "    mode: batch",
        "    editorVersion: 6000.0.32f1",
        "  git:",
        "    historyLimit: 500",
        "",
      ].join("\n"),
      "utf8",
    );

    const loaded = await loadProjectConfig(root);

    assert.equal(loaded.exists, true);
    assert.equal(loaded.valid, true);
    assert.deepEqual(loaded.value.sources.code, ["Assets/Scripts"]);
    assert.deepEqual(loaded.value.sources.semanticExclude, ["Assets/Scripts/Generated/**"]);
    assert.equal(loaded.value.sources.handoff.projectSlug, "example-project");
    assert.equal(loaded.value.services.milvus.address, "localhost:19530");
    assert.equal(loaded.value.services.vectorStore.backend, "milvus");
    assert.equal(loaded.value.services.ollama.url, DEFAULT_CONFIG.services.ollama.url);
    assert.equal(loaded.value.services.ollama.queryExpansionModel, null);
    assert.equal(loaded.value.adapters.unity.mode, "batch");
    assert.equal(loaded.value.adapters.unity.editorVersion, "6000.0.32f1");
    assert.equal(loaded.value.adapters.git.historyLimit, 500);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loadProjectConfig rejects the removed answerModel setting", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-context-config-"));
  try {
    await writeFile(
      path.join(root, PROJECT_CONFIG_FILENAME),
      "version: 1\nservices:\n  ollama:\n    answerModel: obsolete\n",
      "utf8",
    );

    const loaded = await loadProjectConfig(root);

    assert.equal(loaded.valid, false);
    assert.match(loaded.errors.join("\n"), /answerModel/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loadProjectConfig gives an explicit vector-store backend precedence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-context-config-"));
  try {
    await writeFile(
      path.join(root, PROJECT_CONFIG_FILENAME),
      [
        "version: 1",
        "services:",
        "  milvus:",
        "    address: localhost:19530",
        "  vectorStore:",
        "    backend: local",
        "",
      ].join("\n"),
      "utf8",
    );

    const loaded = await loadProjectConfig(root);

    assert.equal(loaded.valid, true);
    assert.equal(loaded.value.services.vectorStore.backend, "local");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loadProjectConfig reports unknown keys without throwing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-context-config-"));
  try {
    await writeFile(
      path.join(root, PROJECT_CONFIG_FILENAME),
      "version: 1\nunknown: true\n",
      "utf8",
    );

    const loaded = await loadProjectConfig(root);

    assert.equal(loaded.exists, true);
    assert.equal(loaded.valid, false);
    assert.match(loaded.errors.join("\n"), /unknown/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
