import { spawn } from "node:child_process";
import path from "node:path";

import { loadProjectConfig } from "./config.js";
import { resolveProjectRoot, toProjectPath } from "./project-path.js";
import type { EvidenceResult, ExactSearchResult } from "./result-format.js";
import {
  classifySource,
  resolveSourceTargets,
  SEARCH_INCLUDE_GLOBS,
  sourceTargetIndex,
  type SearchScope,
  type SourceKind,
  type SourceTarget,
} from "./source-policy.js";

interface RgText {
  text?: string;
  bytes?: string;
}

interface RgMatchEvent {
  type: "match";
  data: {
    path: RgText;
    lines: RgText;
    line_number: number;
  };
}

interface MatchedFile {
  source: SourceKind;
  relativePath: string;
  key: string;
  targetIndex: number;
  segments: Buffer[];
}

// Windows limits a command line to 32,767 characters; file batches stay well
// below that after the fixed arguments and the query.
const MAX_BATCH_PATH_CHARACTERS = 24_000;
// A frequent term fills the result limit from the first few files, so the
// first batch stays small instead of reading limit x limit matching lines.
const FIRST_BATCH_FILES = 16;

function decodeRgText(value: RgText): string | null {
  if (typeof value.text === "string") {
    return value.text;
  }
  if (typeof value.bytes === "string") {
    return Buffer.from(value.bytes, "base64").toString("utf8");
  }
  return null;
}

function uniqueTargetPaths(targets: SourceTarget[]): string[] {
  const seen = new Set<string>();
  const values: string[] = [];
  for (const target of targets) {
    const key = process.platform === "win32"
      ? target.absolutePath.toLowerCase()
      : target.absolutePath;
    if (!seen.has(key)) {
      seen.add(key);
      values.push(target.absolutePath);
    }
  }
  return values;
}

function globArgs(excludes: string[]): string[] {
  const args: string[] = [];
  for (const glob of SEARCH_INCLUDE_GLOBS) {
    args.push("--glob", glob);
  }
  for (const exclude of excludes) {
    args.push(
      "--glob",
      `!${exclude.replace(/^!+/, "").replaceAll("\\", "/")}`,
    );
  }
  return args;
}

function looksLikePath(query: string): boolean {
  return (
    query.includes("/") ||
    query.includes("\\") ||
    /\.(?:asset|asmdef|asmref|cs|jsonc?|md|toml|txt|uss|uxml|ya?ml)$/i.test(
      query,
    )
  );
}

function comparisonKey(relativePath: string): string {
  return process.platform === "win32" ? relativePath.toLowerCase() : relativePath;
}

/**
 * Reproduces the order `rg --sort path` used to produce: configured targets in
 * order, then each directory's entries by UTF-8 name bytes, so a directory's
 * files come before a sibling file whose name extends the directory name.
 */
function compareMatchedFiles(left: MatchedFile, right: MatchedFile): number {
  if (left.targetIndex !== right.targetIndex) return left.targetIndex - right.targetIndex;
  for (let index = 0; index < Math.min(left.segments.length, right.segments.length); index += 1) {
    const order = Buffer.compare(left.segments[index]!, right.segments[index]!);
    if (order !== 0) return order;
  }
  return left.segments.length - right.segments.length;
}

/**
 * Streams ripgrep records. ripgrep searches in parallel only when it does not
 * sort its output, so every caller orders records itself.
 */
function streamRipgrep(
  projectRoot: string,
  args: string[],
  options: {
    separator: "\n" | "\0";
    maxRecordLength: number;
    deadline: number;
    timeoutMs: number;
  },
  onRecord: (record: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("rg", args, {
      cwd: projectRoot,
      shell: false,
      windowsHide: true,
    });
    let buffer = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let received = 0;

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      reject(error);
    };
    const emit = (record: string): void => {
      if (settled || !record) return;
      received += 1;
      try {
        onRecord(record);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, Math.max(1, options.deadline - Date.now()));

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (settled) return;
      buffer += chunk;
      if (buffer.length > options.maxRecordLength && !buffer.includes(options.separator)) {
        fail(new Error("ripgrep returned an excessively long record"));
        return;
      }
      const records = buffer.split(options.separator);
      buffer = records.pop() ?? "";
      for (const record of records) emit(record);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 64 * 1024) stderr += chunk;
    });
    child.once("error", (error) => fail(error));
    child.once("close", (code) => {
      if (settled) return;
      clearTimeout(timer);
      if (timedOut) {
        fail(new Error(`ripgrep timed out after ${options.timeoutMs}ms`));
        return;
      }
      emit(buffer);
      if (settled) return;
      // Exit code 2 also reports a single unreadable or vanished file; the
      // records already received are still valid evidence.
      if (code !== 0 && code !== 1 && !(code === 2 && received > 0)) {
        fail(new Error(stderr.trim() || `ripgrep exited with code ${code}`));
        return;
      }
      settled = true;
      resolve();
    });
  });
}

function matchedFile(
  projectRoot: string,
  reportedPath: string,
  targets: SourceTarget[],
  accept: (key: string) => boolean,
): MatchedFile | null {
  const absolutePath = path.isAbsolute(reportedPath)
    ? path.resolve(reportedPath)
    : path.resolve(projectRoot, reportedPath);
  const relativePath = toProjectPath(path.relative(projectRoot, absolutePath));
  const key = comparisonKey(relativePath);
  if (!accept(key)) return null;
  const source = classifySource(absolutePath, targets);
  if (source === null) return null;
  return {
    source,
    relativePath,
    key,
    targetIndex: sourceTargetIndex(absolutePath, targets),
    segments: relativePath.split("/").map((segment) => Buffer.from(segment, "utf8")),
  };
}

async function searchPaths(
  projectRoot: string,
  query: string,
  targets: SourceTarget[],
  excludes: string[],
  commit: string | null,
  maxResults: number,
  deadline: number,
  timeoutMs: number,
): Promise<{ results: EvidenceResult[]; truncated: boolean }> {
  const comparableQuery = comparisonKey(query.replaceAll("\\", "/"));
  const files = new Map<string, MatchedFile>();
  await streamRipgrep(
    projectRoot,
    ["--no-config", "--files", "--null", ...globArgs(excludes), "--", ...uniqueTargetPaths(targets)],
    { separator: "\0", maxRecordLength: 64 * 1024, deadline, timeoutMs },
    (reportedPath) => {
      const file = matchedFile(
        projectRoot,
        reportedPath,
        targets,
        (key) => key.includes(comparableQuery) && !files.has(key),
      );
      if (file !== null) files.set(file.key, file);
    },
  );
  const ordered = [...files.values()].sort(compareMatchedFiles);
  return {
    results: ordered.slice(0, maxResults).map((file) => ({
      source: file.source,
      path: file.relativePath,
      matchKind: "path",
      lineStart: null,
      lineEnd: null,
      text: file.relativePath,
      score: null,
      indexedAt: null,
      commit,
    })),
    truncated: ordered.length > maxResults,
  };
}

async function searchContent(
  projectRoot: string,
  query: string,
  targets: SourceTarget[],
  excludes: string[],
  commit: string | null,
  maxResults: number,
  deadline: number,
  timeoutMs: number,
): Promise<{ results: EvidenceResult[]; truncated: boolean }> {
  // List every matching file first; each contributes at least one match, so the
  // first maxResults + 1 matches in file order lie within that many files.
  const files = new Map<string, MatchedFile>();
  await streamRipgrep(
    projectRoot,
    [
      "--no-config",
      "--files-with-matches",
      "--null",
      "--fixed-strings",
      ...globArgs(excludes),
      "--",
      query,
      ...uniqueTargetPaths(targets),
    ],
    { separator: "\0", maxRecordLength: 64 * 1024, deadline, timeoutMs },
    (reportedPath) => {
      const file = matchedFile(projectRoot, reportedPath, targets, (key) => !files.has(key));
      if (file !== null) files.set(file.key, file);
    },
  );
  const ordered = [...files.values()].sort(compareMatchedFiles);
  const limit = maxResults + 1;
  const results: EvidenceResult[] = [];
  let next = 0;
  while (next < ordered.length && results.length < limit) {
    const batch: MatchedFile[] = [];
    const batchFiles = next === 0
      ? Math.min(FIRST_BATCH_FILES, limit)
      : limit - results.length;
    let characters = 0;
    while (
      next < ordered.length &&
      batch.length < batchFiles &&
      (batch.length === 0 || characters + ordered[next]!.relativePath.length < MAX_BATCH_PATH_CHARACTERS)
    ) {
      characters += ordered[next]!.relativePath.length + 1;
      batch.push(ordered[next]!);
      next += 1;
    }
    const order = new Map(batch.map((file, index) => [file.key, { file, index }]));
    const matches: Array<{ index: number; evidence: EvidenceResult }> = [];
    const seen = new Set<string>();
    await streamRipgrep(
      projectRoot,
      [
        "--no-config",
        "--json",
        "--fixed-strings",
        "--line-number",
        "--color",
        "never",
        "--max-count",
        String(limit),
        "--",
        query,
        ...batch.map((file) => file.relativePath),
      ],
      { separator: "\n", maxRecordLength: 2 * 1024 * 1024, deadline, timeoutMs },
      (line) => {
        let event: unknown;
        try {
          event = JSON.parse(line);
        } catch {
          throw new Error("ripgrep returned malformed JSON output");
        }
        if (
          typeof event !== "object" ||
          event === null ||
          (event as { type?: unknown }).type !== "match"
        ) {
          return;
        }
        const match = event as RgMatchEvent;
        const reportedPath = decodeRgText(match.data.path);
        const lineText = decodeRgText(match.data.lines);
        if (!reportedPath || lineText === null) return;
        const relativePath = toProjectPath(
          path.relative(projectRoot, path.resolve(projectRoot, reportedPath)),
        );
        const entry = order.get(comparisonKey(relativePath));
        const matchKey = `${comparisonKey(relativePath)}:${match.data.line_number}`;
        if (entry === undefined || seen.has(matchKey)) return;
        seen.add(matchKey);
        matches.push({
          index: entry.index,
          evidence: {
            source: entry.file.source,
            path: entry.file.relativePath,
            matchKind: "content",
            lineStart: match.data.line_number,
            lineEnd: match.data.line_number,
            text: lineText.replace(/[\r\n]+$/, "").slice(0, 2_000),
            score: null,
            indexedAt: null,
            commit,
          },
        });
      },
    );
    matches.sort((left, right) =>
      left.index - right.index ||
      (left.evidence.lineStart ?? 0) - (right.evidence.lineStart ?? 0));
    results.push(...matches.map((match) => match.evidence));
  }
  return {
    results: results.slice(0, maxResults),
    truncated: results.length > maxResults,
  };
}

export async function searchExact(input: {
  projectPath: string;
  query: string;
  scope?: SearchScope;
  maxResults?: number;
  timeoutMs?: number;
}): Promise<ExactSearchResult> {
  const query = input.query;
  if (!query.trim() || query.length > 2_048 || query.includes("\0")) {
    throw new Error("Exact query must contain 1 to 2048 valid characters");
  }
  const maxResults = input.maxResults ?? 50;
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 200) {
    throw new Error("maxResults must be an integer between 1 and 200");
  }
  const scope = input.scope ?? "all";
  const project = await resolveProjectRoot(input.projectPath);
  const loadedConfig = await loadProjectConfig(project.root);
  if (!loadedConfig.exists) {
    throw new Error(`Project config not found: ${loadedConfig.path}`);
  }
  if (!loadedConfig.valid) {
    throw new Error(`Invalid project config: ${loadedConfig.errors.join("; ")}`);
  }
  const targets = await resolveSourceTargets(project.root, loadedConfig.value, scope);
  if (targets.length === 0) {
    return {
      route: "exact",
      fallbackUsed: false,
      query,
      scope,
      commit: project.commit,
      indexedAt: null,
      results: [],
      truncated: false,
    };
  }

  const timeoutMs = input.timeoutMs ?? 15_000;
  const deadline = Date.now() + timeoutMs;
  const search = looksLikePath(query)
    ? await searchPaths(
        project.root,
        query,
        targets,
        loadedConfig.value.exclude,
        project.commit,
        maxResults,
        deadline,
        timeoutMs,
      )
    : await searchContent(
        project.root,
        query,
        targets,
        loadedConfig.value.exclude,
        project.commit,
        maxResults,
        deadline,
        timeoutMs,
      );
  return {
    route: "exact",
    fallbackUsed: false,
    query,
    scope,
    commit: project.commit,
    indexedAt: null,
    ...search,
  };
}
