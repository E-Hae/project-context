import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import {
  FileWalkTimeoutError,
  walkProjectFiles,
  type WalkedFile,
} from "./file-walker.js";
import { resolvePathInsideProject } from "./project-path.js";
import {
  classifySource,
  isAllowedTextFile,
  isExcluded,
  type SourceKind,
  type SourceTarget,
} from "./source-policy.js";

export const MAX_INDEX_FILE_BYTES = 2 * 1024 * 1024;
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

export async function collectProjectFiles(
  projectRoot: string,
  targets: SourceTarget[],
  excludes: string[],
  timeoutMs = 30_000,
): Promise<CollectedSourceFile[]> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("File collection timeout must be positive");
  }
  if (targets.length === 0) return [];

  let walked: WalkedFile[];
  try {
    walked = await walkProjectFiles(projectRoot, targets, excludes, Date.now() + timeoutMs);
  } catch (error) {
    if (error instanceof FileWalkTimeoutError) {
      throw new Error(`File collection timed out after ${timeoutMs}ms`);
    }
    throw error;
  }
  const files: CollectedSourceFile[] = [];
  const seen = new Set<string>();
  for (const { absolutePath, relativePath } of walked) {
    const key =
      process.platform === "win32" ? relativePath.toLowerCase() : relativePath;
    if (
      seen.has(key) ||
      !isAllowedTextFile(relativePath) ||
      isExcluded(relativePath, excludes)
    ) {
      continue;
    }
    const source = classifySource(absolutePath, targets);
    if (source === null) continue;
    seen.add(key);
    files.push({ source, absolutePath, relativePath });
    if (files.length > MAX_COLLECTED_FILES) {
      throw new Error(`Project exceeds the ${MAX_COLLECTED_FILES} file index limit`);
    }
  }
  return files.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath, "en"),
  );
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
