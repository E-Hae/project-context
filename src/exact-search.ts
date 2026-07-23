import { spawn } from "node:child_process";
import path from "node:path";

import { loadProjectConfig } from "./config.js";
import { resolveProjectRoot, toProjectPath } from "./project-path.js";
import type { EvidenceResult, ExactSearchResult } from "./result-format.js";
import {
  classifySource,
  resolveSourceTargets,
  SEARCH_INCLUDE_GLOBS,
  type SearchScope,
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

function buildRgArgs(
  query: string,
  targets: SourceTarget[],
  excludes: string[],
): string[] {
  const args = [
    "--no-config",
    "--json",
    "--fixed-strings",
    "--line-number",
    "--color",
    "never",
    "--sort",
    "path",
  ];
  for (const glob of SEARCH_INCLUDE_GLOBS) {
    args.push("--glob", glob);
  }
  for (const exclude of excludes) {
    args.push(
      "--glob",
      `!${exclude.replace(/^!+/, "").replaceAll("\\", "/")}`,
    );
  }
  args.push("--", query, ...uniqueTargetPaths(targets));
  return args;
}

function buildRgFilesArgs(
  targets: SourceTarget[],
  excludes: string[],
): string[] {
  const args = ["--no-config", "--files", "--null", "--sort", "path"];
  for (const glob of SEARCH_INCLUDE_GLOBS) {
    args.push("--glob", glob);
  }
  for (const exclude of excludes) {
    args.push(
      "--glob",
      `!${exclude.replace(/^!+/, "").replaceAll("\\", "/")}`,
    );
  }
  args.push("--", ...uniqueTargetPaths(targets));
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

function runRipgrepPaths(
  projectRoot: string,
  args: string[],
  query: string,
  targets: SourceTarget[],
  commit: string | null,
  maxResults: number,
  timeoutMs: number,
): Promise<{ results: EvidenceResult[]; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn("rg", args, {
      cwd: projectRoot,
      shell: false,
      windowsHide: true,
    });
    const results: EvidenceResult[] = [];
    const seenPaths = new Set<string>();
    const normalizedQuery = query.replaceAll("\\", "/");
    const comparableQuery =
      process.platform === "win32"
        ? normalizedQuery.toLowerCase()
        : normalizedQuery;
    let stdoutBuffer = "";
    let stderr = "";
    let settled = false;
    let stoppedForLimit = false;
    let timedOut = false;

    const finishWithError = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      reject(error);
    };

    const processPath = (reportedPath: string): void => {
      if (!reportedPath || settled || stoppedForLimit) return;
      const absolutePath = path.isAbsolute(reportedPath)
        ? path.resolve(reportedPath)
        : path.resolve(projectRoot, reportedPath);
      const relativePath = toProjectPath(path.relative(projectRoot, absolutePath));
      const comparablePath =
        process.platform === "win32" ? relativePath.toLowerCase() : relativePath;
      if (!comparablePath.includes(comparableQuery)) return;
      if (seenPaths.has(comparablePath)) return;

      const source = classifySource(absolutePath, targets);
      if (source === null) return;
      seenPaths.add(comparablePath);
      results.push({
        source,
        path: relativePath,
        matchKind: "path",
        lineStart: null,
        lineEnd: null,
        text: relativePath,
        score: null,
        indexedAt: null,
        commit,
      });
      if (results.length > maxResults) {
        stoppedForLimit = true;
        child.kill();
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stoppedForLimit) return;
      stdoutBuffer += chunk;
      if (stdoutBuffer.length > 64 * 1024 && !stdoutBuffer.includes("\0")) {
        finishWithError(new Error("ripgrep returned an excessively long path"));
        return;
      }
      const paths = stdoutBuffer.split("\0");
      stdoutBuffer = paths.pop() ?? "";
      for (const reportedPath of paths) {
        processPath(reportedPath);
        if (stoppedForLimit) {
          stdoutBuffer = "";
          break;
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 64 * 1024) stderr += chunk;
    });
    child.once("error", (error) => finishWithError(error));
    child.once("close", (code) => {
      if (settled) return;
      clearTimeout(timer);
      if (timedOut && !stoppedForLimit) {
        finishWithError(new Error(`ripgrep timed out after ${timeoutMs}ms`));
        return;
      }
      if (!stoppedForLimit && stdoutBuffer) processPath(stdoutBuffer);
      if (settled) return;
      if (!stoppedForLimit && code !== 0 && code !== 1) {
        finishWithError(
          new Error(stderr.trim() || `ripgrep exited with code ${code}`),
        );
        return;
      }
      settled = true;
      resolve({
        results: results.slice(0, maxResults),
        truncated: stoppedForLimit || results.length > maxResults,
      });
    });
  });
}

function runRipgrep(
  projectRoot: string,
  args: string[],
  targets: SourceTarget[],
  commit: string | null,
  maxResults: number,
  timeoutMs: number,
): Promise<{ results: EvidenceResult[]; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn("rg", args, {
      cwd: projectRoot,
      shell: false,
      windowsHide: true,
    });
    const results: EvidenceResult[] = [];
    const seenMatches = new Set<string>();
    let stdoutBuffer = "";
    let stderr = "";
    let settled = false;
    let stoppedForLimit = false;
    let timedOut = false;

    const finishWithError = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      reject(error);
    };

    const processLine = (line: string): void => {
      if (!line || settled || stoppedForLimit) return;
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        finishWithError(new Error("ripgrep returned malformed JSON output"));
        return;
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

      const absolutePath = path.isAbsolute(reportedPath)
        ? path.resolve(reportedPath)
        : path.resolve(projectRoot, reportedPath);
      const source = classifySource(absolutePath, targets);
      if (source === null) return;
      const relativePath = toProjectPath(path.relative(projectRoot, absolutePath));
      const matchKey = `${
        process.platform === "win32" ? relativePath.toLowerCase() : relativePath
      }:${match.data.line_number}`;
      if (seenMatches.has(matchKey)) return;
      seenMatches.add(matchKey);

      results.push({
        source,
        path: relativePath,
        matchKind: "content",
        lineStart: match.data.line_number,
        lineEnd: match.data.line_number,
        text: lineText.replace(/[\r\n]+$/, "").slice(0, 2_000),
        score: null,
        indexedAt: null,
        commit,
      });
      if (results.length > maxResults) {
        stoppedForLimit = true;
        child.kill();
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stoppedForLimit) return;
      stdoutBuffer += chunk;
      if (stdoutBuffer.length > 2 * 1024 * 1024 && !stdoutBuffer.includes("\n")) {
        finishWithError(new Error("ripgrep returned an excessively long JSON line"));
        return;
      }
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        processLine(line);
        if (stoppedForLimit) {
          stdoutBuffer = "";
          break;
        }
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 64 * 1024) stderr += chunk;
    });
    child.once("error", (error) => finishWithError(error));
    child.once("close", (code) => {
      if (settled) return;
      clearTimeout(timer);
      if (timedOut && !stoppedForLimit) {
        finishWithError(new Error(`ripgrep timed out after ${timeoutMs}ms`));
        return;
      }
      if (!stoppedForLimit && stdoutBuffer) processLine(stdoutBuffer);
      if (settled) return;
      if (!stoppedForLimit && code !== 0 && code !== 1) {
        finishWithError(
          new Error(stderr.trim() || `ripgrep exited with code ${code}`),
        );
        return;
      }
      settled = true;
      resolve({
        results: results.slice(0, maxResults),
        truncated: stoppedForLimit || results.length > maxResults,
      });
    });
  });
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
  const search = looksLikePath(query)
    ? await runRipgrepPaths(
        project.root,
        buildRgFilesArgs(targets, loadedConfig.value.exclude),
        query,
        targets,
        project.commit,
        maxResults,
        timeoutMs,
      )
    : await runRipgrep(
        project.root,
        buildRgArgs(query, targets, loadedConfig.value.exclude),
        targets,
        project.commit,
        maxResults,
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
