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
        "  handoff:",
        "    projectSlug: example-project",
        "exclude: [Library/**]",
        "services:",
        "  milvus:",
        "    address: localhost:19530",
        "",
      ].join("\n"),
      "utf8",
    );

    const loaded = await loadProjectConfig(root);

    assert.equal(loaded.exists, true);
    assert.equal(loaded.valid, true);
    assert.deepEqual(loaded.value.sources.code, ["Assets/Scripts"]);
    assert.equal(loaded.value.sources.handoff.projectSlug, "example-project");
    assert.equal(loaded.value.services.milvus.address, "localhost:19530");
    assert.equal(loaded.value.services.ollama.url, DEFAULT_CONFIG.services.ollama.url);
    assert.equal(
      loaded.value.services.ollama.answerModel,
      DEFAULT_CONFIG.services.ollama.answerModel,
    );
    assert.equal(loaded.value.services.ollama.queryExpansionModel, null);
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
