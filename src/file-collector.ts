import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { resolvePathInsideProject, toProjectPath } from "./project-path.js";
import {
  classifySource,
  isAllowedTextFile,
  isExcluded,
  SEARCH_INCLUDE_GLOBS,
  type SourceKind,
  type SourceTarget,
} from "./source-policy.js";

const MAX_INDEX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_COLLECTED_FILES = 100_000;

export interface CollectedSourceFile {
  source: SourceKind;
  absolutePath: string;
  relativePath: string;
  boundaryRoot?: string;
}

export type IndexableFileRead =
  | {
      kind: "ok";
      hash: string;
      text: string;
      byteLength: number;
      encoding: "utf-8" | "euc-kr";
    }
  | { kind: "skipped"; reason: string };

function uniqueTargetPaths(targets: SourceTarget[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const target of targets) {
    const key =
      process.platform === "win32"
        ? target.absolutePath.toLowerCase()
        : target.absolutePath;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(target.relativePath || ".");
  }
  return output;
}

function buildArgs(targets: SourceTarget[], excludes: string[]): string[] {
  const args = ["--no-config", "--files", "--null", "--sort", "path"];
  for (const glob of SEARCH_INCLUDE_GLOBS) args.push("--glob", glob);
  for (const exclude of excludes) {
    args.push(
      "--glob",
      `!${exclude.replace(/^!+/, "").replaceAll("\\", "/")}`,
    );
  }
  args.push("--", ...uniqueTargetPaths(targets));
  return args;
}

export function collectProjectFiles(
  projectRoot: string,
  targets: SourceTarget[],
  excludes: string[],
  timeoutMs = 30_000,
): Promise<CollectedSourceFile[]> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    return Promise.reject(new Error("File collection timeout must be positive"));
  }
  if (targets.length === 0) return Promise.resolve([]);

  return new Promise((resolve, reject) => {
    const child = spawn("rg", buildArgs(targets, excludes), {
      cwd: projectRoot,
      shell: false,
      windowsHide: true,
    });
    const files: CollectedSourceFile[] = [];
    const seen = new Set<string>();
    let stdoutBuffer = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const finishError = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      reject(error);
    };

    const processPath = (reportedPath: string): void => {
      if (!reportedPath || settled) return;
      const absolutePath = path.isAbsolute(reportedPath)
        ? path.resolve(reportedPath)
        : path.resolve(projectRoot, reportedPath);
      const relativePath = toProjectPath(path.relative(projectRoot, absolutePath));
      const key =
        process.platform === "win32" ? relativePath.toLowerCase() : relativePath;
      if (
        seen.has(key) ||
        !isAllowedTextFile(relativePath) ||
        isExcluded(relativePath, excludes)
      ) {
        return;
      }
      const source = classifySource(absolutePath, targets);
      if (source === null) return;
      seen.add(key);
      files.push({ source, absolutePath, relativePath });
      if (files.length > MAX_COLLECTED_FILES) {
        finishError(
          new Error(`Project exceeds the ${MAX_COLLECTED_FILES} file index limit`),
        );
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      if (stdoutBuffer.length > 64 * 1024 && !stdoutBuffer.includes("\0")) {
        finishError(new Error("ripgrep returned an excessively long path"));
        return;
      }
      const paths = stdoutBuffer.split("\0");
      stdoutBuffer = paths.pop() ?? "";
      for (const reportedPath of paths) processPath(reportedPath);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 64 * 1024) stderr += chunk;
    });
    child.once("error", (error) => finishError(error));
    child.once("close", (code) => {
      if (settled) return;
      clearTimeout(timer);
      if (timedOut) {
        finishError(new Error(`File collection timed out after ${timeoutMs}ms`));
        return;
      }
      if (stdoutBuffer) processPath(stdoutBuffer);
      if (settled) return;
      if (code !== 0 && code !== 1) {
        finishError(new Error(stderr.trim() || `ripgrep exited with code ${code}`));
        return;
      }
      files.sort((left, right) =>
        left.relativePath.localeCompare(right.relativePath, "en"),
      );
      settled = true;
      resolve(files);
    });
  });
}

export async function readIndexableFile(
  projectRoot: string,
  file: CollectedSourceFile,
): Promise<IndexableFileRead> {
  let absolutePath: string;
  if (file.boundaryRoot === undefined) {
    const resolved = await resolvePathInsideProject(
      projectRoot,
      file.relativePath,
      true,
    );
    absolutePath = resolved.absolutePath;
  } else {
    const [boundaryRoot, resolvedFile] = await Promise.all([
      realpath(file.boundaryRoot),
      realpath(file.absolutePath),
    ]);
    const rootKey =
      process.platform === "win32" ? boundaryRoot.toLowerCase() : boundaryRoot;
    const fileKey =
      process.platform === "win32" ? resolvedFile.toLowerCase() : resolvedFile;
    const relative = path.relative(rootKey, fileKey);
    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error("External index source resolves outside its boundary root");
    }
    absolutePath = resolvedFile;
  }
  const fileStat = await stat(absolutePath);
  if (!fileStat.isFile()) {
    return { kind: "skipped", reason: "Path is not a regular file" };
  }
  if (fileStat.size > MAX_INDEX_FILE_BYTES) {
    return {
      kind: "skipped",
      reason: `File exceeds ${MAX_INDEX_FILE_BYTES} bytes`,
    };
  }

  const bytes = await readFile(absolutePath);
  if (bytes.includes(0)) {
    return { kind: "skipped", reason: "File contains NUL bytes" };
  }
  let text: string;
  let encoding: "utf-8" | "euc-kr" = "utf-8";
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    try {
      text = new TextDecoder("euc-kr", { fatal: true }).decode(bytes);
      encoding = "euc-kr";
    } catch {
      return { kind: "skipped", reason: "File is neither valid UTF-8 nor EUC-KR" };
    }
  }
  return {
    kind: "ok",
    hash: createHash("sha256").update(bytes).digest("hex"),
    text,
    byteLength: bytes.length,
    encoding,
  };
}
