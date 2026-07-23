import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { loadProjectConfig, PROJECT_CONFIG_FILENAME } from "../src/config.js";
import {
  deriveProjectIndexIdentity,
  saveProjectIndexState,
} from "../src/index-state.js";
import {
  collectProjectStatus,
  type StatusDependencies,
} from "../src/status.js";
import { getRoslynWorkerPath } from "../src/graph-client.js";

test("collectProjectStatus returns unavailable for a missing project", async () => {
  const status = await collectProjectStatus(
    path.join(tmpdir(), "project-context-does-not-exist"),
  );

  assert.equal(status.status, "unavailable");
  assert.equal(status.project.exists, false);
  assert.deepEqual(status.missing, ["project"]);
});

test("collectProjectStatus reports ready local probes and an unbuilt Roslyn worker", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-context-status-"));
  const handoffRoot = path.join(root, "handoff");
  const packageRoot = path.join(root, "package");
  const stateRoot = path.join(root, "state");

  try {
    await writeFile(
      path.join(root, PROJECT_CONFIG_FILENAME),
      [
        "version: 1",
        "sources:",
        "  handoff:",
        "    enabled: true",
        "    projectSlug: FIXTURE",
        "services:",
        "  ollama:",
        "    url: http://localhost:11434/ollama",
        "",
      ].join("\n"),
      "utf8",
    );
    const config = (await loadProjectConfig(root)).value;
    const identity = deriveProjectIndexIdentity(root, config);
    await saveProjectIndexState(
      identity,
      {
        version: 1,
        chunkerVersion: 3,
        projectRoot: root,
        projectSlug: identity.projectSlug,
        collectionName: identity.collectionName,
        embeddingModel: config.services.ollama.embeddingModel,
        embeddingDimension: 768,
        indexedAt: "2026-07-14T00:00:00.000Z",
        commit: "0123456789abcdef",
        files: {},
      },
      stateRoot,
    );
    await mkdir(path.join(handoffRoot, "fixture"), { recursive: true });
    await writeFile(
      path.join(handoffRoot, "fixture", ".project-path"),
      root,
      "utf8",
    );

    let currentCommit = "0123456789abcdef";
    let collectionLoadState = "LoadStateLoaded";
    let collectionLoadProgress = 100;
    const runCommand: StatusDependencies["runCommand"] = async (
      command,
      args,
    ) => {
      if (command === "git" && args.at(-1) === "--show-toplevel") {
        return { ok: true, stdout: root, stderr: "" };
      }
      if (command === "git") {
        return { ok: true, stdout: currentCommit, stderr: "" };
      }
      if (command === "rg") {
        return { ok: true, stdout: "ripgrep 14.1.1", stderr: "" };
      }
      return { ok: false, stdout: "", stderr: "not found", error: "not found" };
    };

    const fetchMock: typeof fetch = async (input) => {
      if (input.toString().includes("/v2/vectordb/collections/has")) {
        return Response.json({ code: 0, data: { has: true } });
      }
      if (input.toString().includes("/v2/vectordb/collections/get_load_state")) {
        return Response.json({
          code: 0,
          data: {
            loadState: collectionLoadState,
            loadProgress: collectionLoadProgress,
          },
        });
      }
      assert.equal(input.toString(), "http://localhost:11434/ollama/api/tags");
      return new Response(
        JSON.stringify({ models: [{ name: "nomic-embed-text:v1.5" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const status = await collectProjectStatus(root, {
      dependencies: {
        runCommand,
        fetch: fetchMock,
        probeTcp: async () => true,
        handoffRoot,
        packageRoot,
        stateRoot,
        now: () => new Date("2026-07-14T00:00:00.000Z"),
      },
    });

    assert.equal(status.status, "degraded");
    assert.equal(status.components.git.state, "ready");
    assert.equal(status.components.ripgrep.state, "ready");
    assert.equal(status.components.ollama.state, "ready");
    assert.equal(status.components.milvus.state, "ready");
    assert.equal(status.components.handoff.state, "ready");
    assert.equal(status.components.roslyn.state, "not_built");
    assert.equal(status.index.state, "ready");
    assert.equal(status.index.stale, false);
    assert.deepEqual(status.missing, ["roslyn"]);

    collectionLoadState = "LoadStateLoading";
    collectionLoadProgress = 0;
    const recoveringStatus = await collectProjectStatus(root, {
      dependencies: {
        runCommand,
        fetch: fetchMock,
        probeTcp: async () => true,
        handoffRoot,
        packageRoot,
        stateRoot,
      },
    });
    assert.equal(recoveringStatus.status, "degraded");
    assert.equal(recoveringStatus.index.state, "invalid");
    assert.deepEqual(recoveringStatus.index.errors, [
      "Milvus index collection is not loaded (LoadStateLoading, 0%)",
    ]);
    assert.deepEqual(recoveringStatus.missing, ["roslyn", "index:invalid"]);

    collectionLoadState = "LoadStateLoaded";
    collectionLoadProgress = 100;
    currentCommit = "fedcba9876543210";
    const staleStatus = await collectProjectStatus(root, {
      dependencies: {
        runCommand,
        fetch: fetchMock,
        probeTcp: async () => true,
        handoffRoot,
        packageRoot,
        stateRoot,
        now: () => new Date("2026-07-14T00:00:01.000Z"),
      },
    });
    assert.equal(staleStatus.status, "degraded");
    assert.equal(staleStatus.index.state, "stale");
    assert.equal(staleStatus.index.stale, true);
    assert.deepEqual(staleStatus.missing, ["roslyn", "index:stale"]);

    const failedTcpStatus = await collectProjectStatus(root, {
      dependencies: {
        runCommand,
        fetch: fetchMock,
        probeTcp: async () => {
          throw new Error("DNS lookup failed");
        },
        handoffRoot,
        packageRoot,
      },
    });

    assert.equal(failedTcpStatus.components.milvus.state, "unreachable");
    assert.match(failedTcpStatus.components.milvus.detail, /DNS lookup failed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("collectProjectStatus degrades when Git metadata is unavailable", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-context-status-"));
  const handoffRoot = path.join(root, "handoff");
  const packageRoot = path.join(root, "package");

  try {
    await writeFile(path.join(root, PROJECT_CONFIG_FILENAME), "version: 1\n", "utf8");
    await mkdir(path.join(handoffRoot, "fixture"), { recursive: true });
    await writeFile(
      path.join(handoffRoot, "fixture", ".project-path"),
      root,
      "utf8",
    );
    const workerPath = getRoslynWorkerPath(packageRoot);
    await mkdir(path.dirname(workerPath), { recursive: true });
    await writeFile(workerPath, "fixture worker\n", "utf8");

    const status = await collectProjectStatus(root, {
      dependencies: {
        runCommand: async (command) => {
          if (command === "git") {
            return {
              ok: false,
              stdout: "",
              stderr: "not a git repository",
              error: "not a git repository",
            };
          }
          return { ok: true, stdout: `${command} test-version`, stderr: "" };
        },
        fetch: async () =>
          new Response(
            JSON.stringify({ models: [{ name: "nomic-embed-text:v1.5" }] }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        probeTcp: async () => true,
        handoffRoot,
        packageRoot,
      },
    });

    assert.equal(status.status, "degraded");
    assert.equal(status.project.gitCommit, null);
    assert.equal(status.components.git.state, "missing");
    assert.equal(status.components.handoff.state, "ready");
    assert.match(status.components.handoff.detail, /disabled/i);
    assert.deepEqual(status.missing, ["git", "index:not_initialized"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
