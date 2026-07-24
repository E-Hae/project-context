import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  TraceAdapterError,
  type TraceAdapter,
  type TraceAdapterEvidence,
  type TraceAdapterRequest,
  type TraceAdapterResponse,
  type TraceSymbol,
} from "project-context-mcp/trace-adapter";

const execFileAsync = promisify(execFile);
const GUID = /(?:guid:\s*|GUID:)([a-f0-9]{32})/giu;
const META_GUID = /^guid:\s*([a-f0-9]{32})\s*$/imu;
const UNITY_EXTENSIONS = [".asset", ".asmdef", ".asmref", ".controller", ".meta", ".prefab", ".unity"];

interface AssetRecord {
  path: string;
  text: string;
  hash: string;
  lines: string[];
  guid: string | null;
  references: Array<{ guid: string; line: number }>;
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function kind(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  return extension === ".prefab" ? "prefab" : extension === ".unity" ? "scene" :
    extension === ".asset" ? "scriptable_object" : extension === ".asmdef" ? "assembly_definition" :
      extension === ".asmref" ? "assembly_reference" : extension === ".meta" ? "meta" : "asset";
}

function symbol(record: AssetRecord): TraceSymbol {
  return {
    name: path.basename(record.path, path.extname(record.path)),
    fullName: record.path,
    signature: record.guid === null ? record.path : `${record.path} (${record.guid})`,
    kind: kind(record.path),
    path: record.path,
    lineStart: 1,
    lineEnd: 1,
    fileHash: record.hash,
    metadata: record.guid === null ? { assetType: kind(record.path) } : { assetType: kind(record.path), guid: record.guid },
  };
}

function evidence(record: AssetRecord, line: number): TraceAdapterEvidence {
  return { path: record.path, lineStart: line, lineEnd: line, text: record.lines[line - 1] ?? "", fileHash: record.hash };
}

async function loadRecords(request: TraceAdapterRequest): Promise<AssetRecord[]> {
  const records: AssetRecord[] = [];
  for (const relativePath of request.files) {
    const absolutePath = path.resolve(request.projectRoot, relativePath);
    const text = await readFile(absolutePath, "utf8");
    const lines = text.replace(/\r\n?/gu, "\n").split("\n");
    const references: Array<{ guid: string; line: number }> = [];
    const meta = path.extname(relativePath).toLowerCase() === ".meta" ? text.match(META_GUID)?.[1]?.toLowerCase() ?? null : null;
    if (meta === null) {
      for (let index = 0; index < lines.length; index += 1) {
        for (const match of lines[index]!.matchAll(GUID)) {
          references.push({ guid: match[1]!.toLowerCase(), line: index + 1 });
        }
      }
    }
    records.push({ path: relativePath.replaceAll("\\", "/"), text, hash: hash(text), lines, guid: meta, references });
  }
  return records;
}

function findUnityEditor(version: string | null): string | null {
  const configured = process.env.PROJECT_CONTEXT_UNITY_EDITOR?.trim();
  if (configured) return configured;
  if (!version) return null;
  if (process.platform === "win32") return path.join(process.env.ProgramFiles ?? "C:/Program Files", "Unity/Hub/Editor", version, "Editor/Unity.exe");
  if (process.platform === "darwin") return `/Applications/Unity/Hub/Editor/${version}/Unity.app/Contents/MacOS/Unity`;
  return path.join("/opt/Unity/Hub/Editor", version, "Editor/Unity");
}

async function batchDependencies(request: TraceAdapterRequest): Promise<Map<string, string[]>> {
  const unity = request.adapterConfig?.unity;
  if (unity?.mode !== "batch") return new Map();
  const editor = findUnityEditor(unity.editorVersion);
  if (editor === null) throw new TraceAdapterError("Unity batch mode requires adapters.unity.editorVersion or PROJECT_CONTEXT_UNITY_EDITOR", "unavailable");
  const output = path.join(tmpdir(), `project-context-unity-${process.pid}-${Date.now()}.json`);
  try {
    await execFileAsync(editor, ["-batchmode", "-nographics", "-quit", "-projectPath", request.projectRoot, "-executeMethod", "ProjectContext.AssetGraph.Export.Run", "-projectContextOutput", output], {
      timeout: unity.batchTimeoutSeconds * 1_000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    const parsed = JSON.parse(await readFile(output, "utf8")) as { dependencies?: Array<{ from: string; to: string }> };
    const result = new Map<string, string[]>();
    for (const edge of parsed.dependencies ?? []) {
      const from = edge.from.replaceAll("\\", "/");
      const to = edge.to.replaceAll("\\", "/");
      result.set(from, [...(result.get(from) ?? []), to]);
    }
    return result;
  } catch (error) {
    throw new TraceAdapterError(
      `Unity batch graph failed. Install the bundled ProjectContext.AssetGraph UPM bridge: ${error instanceof Error ? error.message : String(error)}`,
      "unavailable",
    );
  }
}

export function createUnityTraceAdapter(): TraceAdapter {
  return {
    name: "project-context-mcp-unity",
    language: "unity",
    languageAliases: ["unity-assets"],
    sourceFileExtensions: UNITY_EXTENSIONS,
    async probe() {
      return { available: true, detail: "Unity YAML asset graph analyzer is available", version: "unity-yaml/1.0.0" };
    },
    async trace(request): Promise<TraceAdapterResponse> {
      const startedAt = Date.now();
      const records = await loadRecords(request);
      if (records.length === 0) throw new TraceAdapterError("No Unity asset files were provided", "invalid_request");
      const guidTargets = new Map<string, AssetRecord>();
      for (const record of records) {
        if (record.guid === null) continue;
        const assetPath = record.path.endsWith(".meta") ? record.path.slice(0, -5) : record.path;
        guidTargets.set(record.guid, records.find((candidate) => candidate.path === assetPath) ?? record);
      }
      const normalized = request.symbol.replaceAll("\\", "/").toLowerCase();
      const matched = records.filter((record) => record.path.toLowerCase() === normalized ||
        path.basename(record.path, path.extname(record.path)).toLowerCase() === normalized ||
        record.guid === normalized || guidTargets.get(normalized)?.path === record.path);
      if (matched.length === 0) throw new TraceAdapterError(`Unity asset was not found: ${request.symbol}`, "symbol_not_found");
      const batch = await batchDependencies(request);
      const edges: TraceAdapterResponse["results"] = [];
      const addEdge = (from: AssetRecord, to: AssetRecord | null, line: number, relation = "references") => {
        edges.push({ relation, from: symbol(from), to: to === null ? { name: "unresolved", fullName: "unresolved", signature: "unresolved Unity GUID", kind: "external_asset", path: null, lineStart: null, lineEnd: null, fileHash: null } : symbol(to), evidence: evidence(from, line) });
      };
      if (request.direction === "callees") {
        for (const from of matched) {
          for (const reference of from.references) addEdge(from, guidTargets.get(reference.guid) ?? null, reference.line);
          for (const targetPath of batch.get(from.path) ?? []) {
            const to = records.find((record) => record.path === targetPath) ?? null;
            addEdge(from, to, 1, "asset_database_dependency");
          }
        }
      } else {
        const targetPaths = new Set(matched.map((record) => record.path));
        const targetGuids = new Set(matched.flatMap((record) => record.guid === null ? [] : [record.guid]));
        for (const from of records) {
          for (const reference of from.references) {
            const target = guidTargets.get(reference.guid) ?? null;
            if ((target !== null && targetPaths.has(target.path)) || targetGuids.has(reference.guid)) addEdge(from, target, reference.line);
          }
          for (const targetPath of batch.get(from.path) ?? []) {
            if (targetPaths.has(targetPath)) addEdge(from, records.find((record) => record.path === targetPath) ?? null, 1, "asset_database_dependency");
          }
        }
      }
      const limited = edges.slice(0, request.maxResults);
      return { workerVersion: request.adapterConfig?.unity.mode === "batch" ? "unity-batch/1.0.0" : "unity-yaml/1.0.0", symbol: request.symbol, direction: request.direction, matchedSymbols: matched.map(symbol), results: limited, truncated: edges.length > limited.length, diagnostics: { filesRequested: request.files.length, filesLoaded: records.length, filesSkipped: 0, partial: false, elapsedMs: Date.now() - startedAt, messages: request.adapterConfig?.unity.mode === "batch" ? ["Unity batch bridge dependencies included"] : [] } };
    },
  };
}

export const traceAdapter = createUnityTraceAdapter();
