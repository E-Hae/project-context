import { close, fstat, open, read } from "node:fs";

import { loadProjectConfig } from "./config.js";
import {
  FileWalkTimeoutError,
  walkProjectFiles,
  type WalkedFile,
} from "./file-walker.js";
import { resolveProjectRoot } from "./project-path.js";
import type { EvidenceResult, ExactSearchResult } from "./result-format.js";
import {
  classifySource,
  resolveSourceTargets,
  sourceTargetIndex,
  type SearchScope,
  type SourceKind,
  type SourceTarget,
} from "./source-policy.js";

interface MatchedFile {
  source: SourceKind;
  absolutePath: string;
  relativePath: string;
  key: string;
  targetIndex: number;
  segments: Buffer[];
}

interface LineMatch {
  line: number;
  text: string;
}

// Files read ahead while matches are taken in file order.
const SCAN_CONCURRENCY = 16;
// Larger files are not searched rather than read whole into memory.
const MAX_SEARCH_FILE_BYTES = 256 * 1024 * 1024;
// Read-ahead stops once the raw buffers of the files being searched hold this
// many bytes; decoding a UTF-16 file briefly needs about three times its size.
const MAX_READ_AHEAD_BYTES = 256 * 1024 * 1024;
// Bytes decoded per matching line; enough for the 2,000 returned characters.
const MAX_LINE_DECODE_BYTES = 8 * 1024;
const MAX_LINE_TEXT_CHARACTERS = 2_000;

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
 * Orders files by configured target, then each directory's entries by UTF-8
 * name bytes, so a directory's files come before a sibling file whose name
 * extends the directory name.
 */
function compareMatchedFiles(left: MatchedFile, right: MatchedFile): number {
  if (left.targetIndex !== right.targetIndex) return left.targetIndex - right.targetIndex;
  for (let index = 0; index < Math.min(left.segments.length, right.segments.length); index += 1) {
    const order = Buffer.compare(left.segments[index]!, right.segments[index]!);
    if (order !== 0) return order;
  }
  return left.segments.length - right.segments.length;
}

class ExactSearchTimeoutError extends Error {}

/** Drops a UTF-8 byte-order mark and converts UTF-16 text with one to UTF-8. */
function searchableBytes(bytes: Buffer): Buffer {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return bytes.subarray(3);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return Buffer.from(bytes.subarray(2).toString("utf16le"), "utf8");
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.from(bytes.subarray(2, 2 + ((bytes.length - 2) & ~1)));
    return Buffer.from(swapped.swap16().toString("utf16le"), "utf8");
  }
  return bytes;
}

/** Bounds the bytes that read-ahead files hold at once; one file may exceed it alone. */
class ReadBudget {
  private used = 0;
  private waiting: Array<() => void> = [];

  /** Runs `start` once `bytes` fit, synchronously when they already do. */
  acquire(bytes: number, start: () => void): void {
    if (this.used > 0 && this.used + bytes > MAX_READ_AHEAD_BYTES) {
      this.waiting.push(() => this.acquire(bytes, start));
      return;
    }
    this.used += bytes;
    start();
  }

  release(bytes: number): void {
    this.used -= bytes;
    const waiting = this.waiting;
    this.waiting = [];
    for (const wake of waiting) wake();
  }
}

/** Set once a search returns, so read-ahead it no longer needs stops early. */
interface ScanControl {
  stopped: boolean;
}

/**
 * Reads a regular file of at most MAX_SEARCH_FILE_BYTES, or returns null,
 * also once `control.stopped` is set.
 * The caller releases `reserved` bytes of the budget once done with `bytes`.
 * Uses the callback API, which reads a whole file in fewer round trips than
 * fs/promises.
 */
function readSearchFile(
  absolutePath: string,
  budget: ReadBudget,
  control: ScanControl,
): Promise<{ bytes: Buffer; reserved: number } | null> {
  return new Promise((resolve, reject) => {
    if (control.stopped) {
      resolve(null);
      return;
    }
    open(absolutePath, "r", (openError, fd) => {
      if (openError) {
        reject(openError);
        return;
      }
      let reserved = 0;
      const finish = (error: Error | null, bytes: Buffer | null): void => {
        if (error || bytes === null) budget.release(reserved);
        close(fd, () => {
          if (error) reject(error);
          else resolve(bytes === null ? null : { bytes, reserved });
        });
      };
      fstat(fd, (statError, fileStat) => {
        if (statError) {
          finish(statError, null);
          return;
        }
        if (control.stopped || !fileStat.isFile() || fileStat.size > MAX_SEARCH_FILE_BYTES) {
          finish(null, null);
          return;
        }
        budget.acquire(fileStat.size, () => {
          reserved = fileStat.size;
          if (control.stopped) {
            finish(null, null);
            return;
          }
          const buffer = Buffer.allocUnsafe(fileStat.size);
          let offset = 0;
          const next = (): void => {
            if (offset >= buffer.length) {
              finish(null, buffer);
              return;
            }
            if (control.stopped) {
              finish(null, null);
              return;
            }
            read(fd, buffer, offset, buffer.length - offset, null, (readError, bytesRead) => {
              if (readError) {
                finish(readError, null);
                return;
              }
              if (bytesRead === 0) {
                finish(null, buffer.subarray(0, offset));
                return;
              }
              offset += bytesRead;
              next();
            });
          };
          next();
        });
      });
    });
  });
}

/**
 * Returns up to maxLines lines that contain the query, one entry per line.
 * Files containing a NUL byte are binary and yield nothing.
 */
async function scanFile(
  absolutePath: string,
  needle: Buffer,
  maxLines: number,
  budget: ReadBudget,
  control: ScanControl,
): Promise<LineMatch[]> {
  let file: { bytes: Buffer; reserved: number } | null;
  try {
    file = await readSearchFile(absolutePath, budget, control);
  } catch (error) {
    // A file that vanished or cannot be read is skipped like a missing match.
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (
      code === "ENOENT" ||
      code === "EACCES" ||
      code === "EPERM" ||
      code === "EBUSY" ||
      code === "EISDIR"
    ) {
      return [];
    }
    throw error;
  }
  if (file === null) return [];
  try {
    return findLines(searchableBytes(file.bytes), needle, maxLines);
  } finally {
    budget.release(file.reserved);
  }
}

function findLines(bytes: Buffer, needle: Buffer, maxLines: number): LineMatch[] {
  // Most files lack the query, so the binary check runs only after a hit.
  if (bytes.indexOf(needle) === -1 || bytes.includes(0)) return [];
  const matches: LineMatch[] = [];
  // lineStart is the offset where line number `line` begins.
  let line = 1;
  let lineStart = 0;
  while (matches.length < maxLines) {
    const found = bytes.indexOf(needle, lineStart);
    if (found === -1) break;
    for (
      let newline = bytes.indexOf(10, lineStart);
      newline !== -1 && newline < found;
      newline = bytes.indexOf(10, lineStart)
    ) {
      line += 1;
      lineStart = newline + 1;
    }
    const newline = bytes.indexOf(10, found);
    const lineEnd = newline === -1 ? bytes.length : newline;
    matches.push({
      line,
      text: bytes
        .subarray(lineStart, Math.min(lineEnd, lineStart + MAX_LINE_DECODE_BYTES))
        .toString("utf8")
        .replace(/[\r\n]+$/, "")
        .slice(0, MAX_LINE_TEXT_CHARACTERS),
    });
    if (newline === -1) break;
    line += 1;
    lineStart = newline + 1;
  }
  return matches;
}

async function listMatchedFiles(
  projectRoot: string,
  targets: SourceTarget[],
  excludes: string[],
  deadline: number,
  accept: (key: string) => boolean,
): Promise<MatchedFile[]> {
  let walked: WalkedFile[];
  try {
    walked = await walkProjectFiles(projectRoot, targets, excludes, deadline);
  } catch (error) {
    if (error instanceof FileWalkTimeoutError) throw new ExactSearchTimeoutError();
    throw error;
  }
  const files = new Map<string, MatchedFile>();
  for (const { absolutePath, relativePath } of walked) {
    const key = comparisonKey(relativePath);
    if (files.has(key) || !accept(key)) continue;
    const source = classifySource(absolutePath, targets);
    if (source === null) continue;
    files.set(key, {
      source,
      absolutePath,
      relativePath,
      key,
      targetIndex: sourceTargetIndex(absolutePath, targets),
      segments: relativePath.split("/").map((segment) => Buffer.from(segment, "utf8")),
    });
  }
  return [...files.values()].sort(compareMatchedFiles);
}

async function searchPaths(
  projectRoot: string,
  query: string,
  targets: SourceTarget[],
  excludes: string[],
  commit: string | null,
  maxResults: number,
  deadline: number,
): Promise<{ results: EvidenceResult[]; truncated: boolean }> {
  const comparableQuery = comparisonKey(query.replaceAll("\\", "/"));
  const ordered = await listMatchedFiles(
    projectRoot,
    targets,
    excludes,
    deadline,
    (key) => key.includes(comparableQuery),
  );
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
): Promise<{ results: EvidenceResult[]; truncated: boolean }> {
  if (query.includes("\n")) {
    throw new Error("Exact content query must not contain a line break");
  }
  const ordered = await listMatchedFiles(projectRoot, targets, excludes, deadline, () => true);
  const needle = Buffer.from(query, "utf8");
  // Each file contributes at most `limit` lines, and files are taken in order
  // until `limit` lines are found, so the result is the first `limit` matching
  // lines in file order.
  const limit = maxResults + 1;
  const budget = new ReadBudget();
  const control: ScanControl = { stopped: false };
  const scans: Array<Promise<LineMatch[]>> = [];
  const startScan = (index: number): void => {
    const scan = scanFile(ordered[index]!.absolutePath, needle, limit, budget, control);
    scan.catch(() => undefined);
    scans[index] = scan;
  };
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new ExactSearchTimeoutError()),
      Math.max(1, deadline - Date.now()),
    );
  });
  expired.catch(() => undefined);
  const results: EvidenceResult[] = [];
  try {
    for (let index = 0; index < ordered.length && results.length < limit; index += 1) {
      for (let ahead = scans.length; ahead < Math.min(ordered.length, index + SCAN_CONCURRENCY); ahead += 1) {
        startScan(ahead);
      }
      const file = ordered[index]!;
      for (const match of await Promise.race([scans[index]!, expired])) {
        results.push({
          source: file.source,
          path: file.relativePath,
          matchKind: "content",
          lineStart: match.line,
          lineEnd: match.line,
          text: match.text,
          score: null,
          indexedAt: null,
          commit,
        });
      }
    }
  } finally {
    clearTimeout(timer);
    control.stopped = true;
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
  const search = looksLikePath(query) ? searchPaths : searchContent;
  let found: { results: EvidenceResult[]; truncated: boolean };
  try {
    found = await search(
      project.root,
      query,
      targets,
      loadedConfig.value.exclude,
      project.commit,
      maxResults,
      deadline,
    );
  } catch (error) {
    if (error instanceof ExactSearchTimeoutError) {
      throw new Error(`Exact search timed out after ${timeoutMs}ms`);
    }
    throw error;
  }
  return {
    route: "exact",
    fallbackUsed: false,
    query,
    scope,
    commit: project.commit,
    indexedAt: null,
    ...found,
  };
}
