import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { loadProjectConfig } from "../src/config.js";
import {
  deriveProjectIndexIdentity,
  saveProjectIndexState,
} from "../src/index-state.js";
import {
  collectProjectStatus,
  type StatusDependencies,
} from "../src/status.js";
import { LocalVectorStore } from "../src/local-vector-store.js";
import { writeProjectConfig } from "./project-config-fixture.js";

test("collectProjectStatus returns unavailable for a missing project", async () => {
  const status = await collectProjectStatus(
    path.join(tmpdir(), "project-context-does-not-exist"),
  );

  assert.equal(status.status, "unavailable");
  assert.equal(status.project.exists, false);
  assert.deepEqual(status.missing, ["project"]);
});

test("collectProjectStatus does not degrade when no trace adapter is installed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-context-status-"));
  const handoffRoot = path.join(root, "handoff");
  const packageRoot = path.join(root, "package");
  const stateRoot = path.join(root, "state");

  try {
    await writeProjectConfig(
      root,
      [
        "version: 1",
        "sources:",
        "  handoff:",
        "    enabled: true",
        "    projectSlug: FIXTURE",
        "services:",
        "  vectorStore:",
        "    backend: milvus",
        "  ollama:",
        "    url: http://localhost:11434/ollama",
        "",
      ].join("\n"),
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
        discoverTraceAdapters: async () => ({
          candidates: ["project-context-mcp-csharp"],
          adapters: [],
          diagnostics: [],
        }),
      },
    });

    assert.equal(status.status, "ready");
    assert.equal(status.components.git.state, "ready");
    assert.equal(status.components.ripgrep.state, "ready");
    assert.equal(status.components.ollama.state, "ready");
    assert.equal(status.components.milvus.state, "ready");
    assert.equal(status.components.handoff.state, "ready");
    assert.equal(status.components.trace.state, "ready");
    assert.deepEqual(status.components.trace.adapters, []);
    assert.equal(status.index.state, "ready");
    assert.equal(status.index.stale, false);
    assert.deepEqual(status.missing, []);

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
    assert.deepEqual(recoveringStatus.missing, ["index:invalid"]);

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
    assert.deepEqual(staleStatus.missing, ["index:stale"]);

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

test("collectProjectStatus reports a malformed trace probe as unavailable", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-context-status-"));
  try {
    await writeProjectConfig(root, "version: 1\n");
    const status = await collectProjectStatus(root, {
      dependencies: {
        runCommand: async (command, args) => {
          if (command === "git" && args.at(-1) === "--show-toplevel") {
            return { ok: true, stdout: root, stderr: "" };
          }
          if (command === "git") return { ok: true, stdout: "0123456789abcdef", stderr: "" };
          if (command === "rg") return { ok: true, stdout: "ripgrep 14.1.1", stderr: "" };
          return { ok: false, stdout: "", stderr: "not found", error: "not found" };
        },
        fetch: async () => Response.json({ models: [{ name: "nomic-embed-text:v1.5" }] }),
        discoverTraceAdapters: async () => ({
          candidates: ["malformed-adapter"],
          adapters: [{
            name: "malformed-adapter",
            language: "fixture",
            sourceFileExtensions: [".fixture"],
            probe: async () => ({ available: "yes", detail: 1, version: 2 } as never),
            trace: async () => { throw new Error("not used"); },
          }],
          diagnostics: [],
        }),
        stateRoot: path.join(root, "state"),
      },
    });
    assert.equal(status.components.trace.state, "missing");
    assert.equal(status.components.trace.adapters?.[0]?.state, "missing");
    assert.match(status.components.trace.adapters?.[0]?.detail ?? "", /invalid response/);
    assert.equal(status.missing.includes("trace_adapter"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("collectProjectStatus does not probe Milvus when the local vector store is selected", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-context-status-"));
  try {
    await writeProjectConfig(root, "version: 1\n");
    let probeCalls = 0;
    const status = await collectProjectStatus(root, {
      dependencies: {
        runCommand: async (command, args) => {
          if (command === "git" && args.at(-1) === "--show-toplevel") {
            return { ok: true, stdout: root, stderr: "" };
          }
          if (command === "git") {
            return { ok: true, stdout: "0123456789abcdef", stderr: "" };
          }
          if (command === "rg") {
            return { ok: true, stdout: "ripgrep 14.1.1", stderr: "" };
          }
          return { ok: false, stdout: "", stderr: "not found", error: "not found" };
        },
        fetch: async () => Response.json({
          models: [{ name: "nomic-embed-text:v1.5" }],
        }),
        probeTcp: async () => {
          probeCalls += 1;
          throw new Error("Milvus should not be probed");
        },
        packageRoot: path.join(root, "package"),
        stateRoot: path.join(root, "state"),
      },
    });

    assert.equal(probeCalls, 0);
    assert.equal(status.components.milvus.state, "ready");
    assert.match(status.components.milvus.detail, /local vector store/i);
    assert.equal(status.missing.includes("milvus"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("collectProjectStatus invalidates a local index whose collection is missing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-context-status-"));
  const stateRoot = path.join(root, "state");
  try {
    await writeProjectConfig(root, "version: 1\n");
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
        vectorStoreBackend: "local",
        embeddingModel: config.services.ollama.embeddingModel,
        embeddingDimension: 2,
        indexedAt: "2026-07-23T00:00:00.000Z",
        commit: "0123456789abcdef",
        files: {},
      },
      stateRoot,
    );
    const store = new LocalVectorStore(stateRoot);
    await store.ensureCollection(identity.collectionName, 2);
    await store.dropCollection(identity.collectionName);
    let probeCalls = 0;

    const status = await collectProjectStatus(root, {
      dependencies: {
        runCommand: async (command, args) => {
          if (command === "git" && args.at(-1) === "--show-toplevel") {
            return { ok: true, stdout: root, stderr: "" };
          }
          if (command === "git") {
            return { ok: true, stdout: "0123456789abcdef", stderr: "" };
          }
          if (command === "rg") {
            return { ok: true, stdout: "ripgrep 14.1.1", stderr: "" };
          }
          return { ok: false, stdout: "", stderr: "not found", error: "not found" };
        },
        fetch: async () => Response.json({
          models: [{ name: "nomic-embed-text:v1.5" }],
        }),
        probeTcp: async () => {
          probeCalls += 1;
          return false;
        },
        packageRoot: path.join(root, "package"),
        stateRoot,
      },
    });

    assert.equal(probeCalls, 0);
    assert.equal(status.index.state, "invalid");
    assert.deepEqual(status.index.errors, ["Local vector index collection is missing"]);
    assert.equal(status.missing.includes("index:invalid"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("collectProjectStatus degrades when Git metadata is unavailable", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-context-status-"));
  const handoffRoot = path.join(root, "handoff");
  const packageRoot = path.join(root, "package");

  try {
    await writeProjectConfig(root, "version: 1\n");
    await mkdir(path.join(handoffRoot, "fixture"), { recursive: true });
    await writeFile(
      path.join(handoffRoot, "fixture", ".project-path"),
      root,
      "utf8",
    );
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
