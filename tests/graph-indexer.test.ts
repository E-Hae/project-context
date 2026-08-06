import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_CONFIG } from "../src/config.js";
import { MAX_INDEX_FILE_BYTES } from "../src/file-collector.js";
import {
  buildProjectGraph,
  MAX_GRAPH_AUXILIARY_FILES,
  MAX_GRAPH_INPUT_BYTES,
  MAX_GRAPH_SOURCE_FILES,
} from "../src/graph-indexer.js";
import type { CollectedSourceFile } from "../src/file-collector.js";
import type { TraceAdapter } from "../src/trace-adapter.js";

test("graph indexing bounds adapter source input before graph builders read files", async () => {
  let requestedFiles: string[] = [];
  let requestedAuxiliaryFiles: string[] = [];
  const adapter: TraceAdapter = {
    name: "fixture-adapter",
    language: "fixture",
    sourceFileExtensions: [".ts"],
    auxiliaryFileExtensions: [".json"],
    async probe() { return { available: true, detail: "fixture" }; },
    async trace() { throw new Error("trace is not used"); },
    async buildGraph(request) {
      requestedFiles = request.files;
      requestedAuxiliaryFiles = request.auxiliaryFiles;
      return {
        workerVersion: "fixture/1.0",
        nodes: [],
        results: [],
        diagnostics: {
          filesRequested: request.files.length,
          filesLoaded: request.files.length,
          filesSkipped: 0,
          partial: false,
          elapsedMs: 0,
          messages: [],
        },
        truncated: false,
      };
    },
  };
  const sourceFiles: CollectedSourceFile[] = Array.from(
    { length: MAX_GRAPH_SOURCE_FILES + 1 },
    (_, index) => ({
      source: "code",
      absolutePath: `/fixture/src/${String(index).padStart(5, "0")}.ts`,
      relativePath: `src/${String(index).padStart(5, "0")}.ts`,
    }),
  );
  const auxiliaryFiles: CollectedSourceFile[] = Array.from(
    { length: MAX_GRAPH_AUXILIARY_FILES + 1 },
    (_, index) => ({
      source: "code",
      absolutePath: `/fixture/config/${String(index).padStart(5, "0")}.json`,
      relativePath: `config/${String(index).padStart(5, "0")}.json`,
    }),
  );
  const result = await buildProjectGraph({
    projectRoot: "/fixture",
    config: DEFAULT_CONFIG,
    files: [...sourceFiles, ...auxiliaryFiles],
  }, {
    dependencies: {
      discoverAdapters: async () => ({ candidates: [adapter.name], adapters: [adapter], diagnostics: [] }),
      getFileSize: async (file) =>
        file.relativePath === "src/00000.ts" || file.relativePath === "config/00000.json"
          ? MAX_INDEX_FILE_BYTES + 1
          : 0,
    },
  });
  assert.equal(requestedFiles.length, MAX_GRAPH_SOURCE_FILES - 1);
  assert.deepEqual(requestedFiles, [...requestedFiles].sort((left, right) => left.localeCompare(right, "en")));
  assert.equal(requestedAuxiliaryFiles.length, MAX_GRAPH_AUXILIARY_FILES - 1);
  assert.deepEqual(requestedAuxiliaryFiles, [...requestedAuxiliaryFiles].sort((left, right) => left.localeCompare(right, "en")));
  assert.equal(result.shards[0]?.truncated, true);
  assert.equal(result.shards[0]?.diagnostics.partial, true);
  assert.equal(result.shards[0]?.diagnostics.filesSkipped, 4);
  assert.equal(result.shards[0]?.diagnostics.messages.includes(
    `Graph input skipped 2 source and 2 auxiliary files (limits: ${MAX_GRAPH_SOURCE_FILES}/${MAX_GRAPH_AUXILIARY_FILES} files, ${MAX_INDEX_FILE_BYTES} bytes per file, ${MAX_GRAPH_INPUT_BYTES} bytes total)`), true);
});

test("graph indexing applies one path-sorted aggregate byte budget across source and auxiliary input", async () => {
  let requestedFiles: string[] = [];
  let requestedAuxiliaryFiles: string[] = [];
  const adapter: TraceAdapter = {
    name: "aggregate-fixture",
    language: "fixture",
    sourceFileExtensions: [".ts"],
    auxiliaryFileExtensions: [".json"],
    async probe() { return { available: true, detail: "fixture" }; },
    async trace() { throw new Error("trace is not used"); },
    async buildGraph(request) {
      requestedFiles = request.files;
      requestedAuxiliaryFiles = request.auxiliaryFiles;
      return {
        workerVersion: "fixture/1.0",
        nodes: [],
        results: [],
        diagnostics: {
          filesRequested: request.files.length,
          filesLoaded: request.files.length,
          filesSkipped: 0,
          partial: false,
          elapsedMs: 0,
          messages: [],
        },
        truncated: false,
      };
    },
  };
  const sourceFiles: CollectedSourceFile[] = Array.from({ length: 40 }, (_, index) => ({
    source: "code",
    absolutePath: `/fixture/a/${String(index).padStart(2, "0")}.ts`,
    relativePath: `a/${String(index).padStart(2, "0")}.ts`,
  }));
  const auxiliaryFiles: CollectedSourceFile[] = Array.from({ length: 40 }, (_, index) => ({
    source: "code",
    absolutePath: `/fixture/b/${String(index).padStart(2, "0")}.json`,
    relativePath: `b/${String(index).padStart(2, "0")}.json`,
  }));
  const result = await buildProjectGraph({
    projectRoot: "/fixture",
    config: DEFAULT_CONFIG,
    files: [...sourceFiles, ...auxiliaryFiles],
  }, {
    dependencies: {
      discoverAdapters: async () => ({ candidates: [adapter.name], adapters: [adapter], diagnostics: [] }),
      getFileSize: async () => MAX_INDEX_FILE_BYTES,
    },
  });
  assert.equal(requestedFiles.length, MAX_GRAPH_INPUT_BYTES / MAX_INDEX_FILE_BYTES);
  assert.deepEqual(requestedAuxiliaryFiles, []);
  assert.equal(result.shards[0]?.diagnostics.filesSkipped, 48);
  assert.equal(result.shards[0]?.truncated, true);
});

test("graph indexing does not invoke an adapter when every source exceeds the byte limit", async () => {
  let called = false;
  const adapter: TraceAdapter = {
    name: "oversized-fixture",
    language: "fixture",
    sourceFileExtensions: [".ts"],
    async probe() { return { available: true, detail: "fixture" }; },
    async trace() { throw new Error("trace is not used"); },
    async buildGraph() {
      called = true;
      throw new Error("adapter must not read oversized input");
    },
  };
  const result = await buildProjectGraph({
    projectRoot: "/fixture",
    config: DEFAULT_CONFIG,
    files: [{ source: "code", absolutePath: "/fixture/src/large.ts", relativePath: "src/large.ts" }],
  }, {
    dependencies: {
      discoverAdapters: async () => ({ candidates: [adapter.name], adapters: [adapter], diagnostics: [] }),
      getFileSize: async () => MAX_INDEX_FILE_BYTES + 1,
    },
  });
  assert.equal(called, false);
  assert.deepEqual(result.shards, []);
  assert.match(result.diagnostics[0] ?? "", /no source files within the 2097152-byte graph input limit/);
});
