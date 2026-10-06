import type { Dirent } from "node:fs";
import { lstat, readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Minimatch } from "minimatch";

import { toProjectPath } from "./project-path.js";
import { SEARCH_INCLUDE_GLOBS, type SourceTarget } from "./source-policy.js";

/**
 * Lists the files under the configured source targets with these rules:
 * - A file is listed when the last configured glob it matches is an include
 *   glob; ignore files and hidden names never drop a file.
 * - A directory is skipped when the last glob it matches is an exclude glob;
 *   with no glob match, `.ignore` rules, then `.gitignore`, `.git/info/exclude`
 *   and the global Git excludes file decide, and a hidden name skips it last.
 * - Files named directly as targets are always listed; symbolic links are not
 *   followed.
 * Ignore files apply from the filesystem root down; Git rules apply only up to
 * the nearest directory that contains `.git`, and only inside a repository.
 */

export interface WalkedFile {
  absolutePath: string;
  /** Project-relative path with forward slashes. */
  relativePath: string;
}

export class FileWalkTimeoutError extends Error {
  constructor() {
    super("File walk timed out");
    this.name = "FileWalkTimeoutError";
  }
}

type RuleMatch = "ignore" | "allow" | null;

interface IgnoreRule {
  allow: boolean;
  directoryOnly: boolean;
  /** Matches the entry name instead of the path below the rule's directory. */
  nameOnly: boolean;
  test: (value: string) => boolean;
}

interface IgnoreFrame {
  directory: string;
  parent: IgnoreFrame | null;
  ignore: IgnoreRule[];
  gitignore: IgnoreRule[];
  gitExclude: IgnoreRule[];
  hasGit: boolean;
  /** Whether this directory or an ancestor contains `.git`. */
  inGit: boolean;
}

interface WalkContext {
  projectRoot: string;
  overrides: IgnoreRule[];
  globalGitignore: IgnoreRule[];
  deadline: number;
  limit: <T>(task: () => Promise<T>) => Promise<T>;
  files: WalkedFile[];
}

const WALK_CONCURRENCY = 16;
const MINIMATCH_OPTIONS = {
  dot: true,
  nocomment: true,
  nonegate: true,
  noext: true,
  platform: "linux",
} as const;
const IGNORED_FS_ERRORS = new Set(["ENOENT", "ENOTDIR", "EACCES", "EPERM", "EBUSY", "ELOOP"]);

function isIgnoredFsError(error: unknown): boolean {
  return IGNORED_FS_ERRORS.has((error as NodeJS.ErrnoException | null)?.code ?? "");
}

function createLimiter(concurrency: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= concurrency) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}

/** Compiles a pattern with Git ignore syntax; returns null for blank lines and comments. */
function compileRule(line: string): IgnoreRule | null {
  let pattern = line.replace(/\r$/, "");
  if (pattern.startsWith("#")) return null;
  while (pattern.endsWith(" ") && !pattern.endsWith("\\ ")) {
    pattern = pattern.slice(0, -1);
  }
  if (!pattern) return null;
  let allow = false;
  if (pattern.startsWith("!")) {
    allow = true;
    pattern = pattern.slice(1);
  } else if (pattern.startsWith("\\!") || pattern.startsWith("\\#")) {
    pattern = pattern.slice(1);
  }
  let directoryOnly = false;
  if (pattern.endsWith("/") && pattern.length > 1) {
    directoryOnly = true;
    pattern = pattern.slice(0, -1);
  }
  // "**/name" matches at any depth, which is what a pattern without "/" does.
  if (/^\*\*\/[^/]+$/.test(pattern)) pattern = pattern.slice(3);
  const nameOnly = !pattern.includes("/");
  if (pattern.startsWith("/")) pattern = pattern.slice(1);
  if (!pattern) return null;

  const extension = /^\*(\.[A-Za-z0-9_-]+)$/.exec(pattern)?.[1];
  const prefix = /^([^*?[\\{]+\/)\*\*$/.exec(pattern)?.[1];
  let test: (value: string) => boolean;
  if (extension !== undefined && nameOnly) {
    test = (value) => value.endsWith(extension);
  } else if (prefix !== undefined) {
    test = (value) => value.startsWith(prefix);
  } else if (!/[*?[\\{]/.test(pattern)) {
    test = (value) => value === pattern;
  } else {
    const matcher = new Minimatch(pattern, MINIMATCH_OPTIONS);
    test = (value) => matcher.match(value);
  }
  return { allow, directoryOnly, nameOnly, test };
}

function compileRules(lines: Iterable<string>): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const line of lines) {
    const rule = compileRule(line);
    if (rule !== null) rules.push(rule);
  }
  return rules;
}

/** The last matching rule decides, as in a Git ignore file. */
function matchRules(
  rules: IgnoreRule[],
  relativePath: string,
  name: string,
  isDirectory: boolean,
): RuleMatch {
  for (let index = rules.length - 1; index >= 0; index -= 1) {
    const rule = rules[index]!;
    if (rule.directoryOnly && !isDirectory) continue;
    if (rule.test(rule.nameOnly ? name : relativePath)) {
      return rule.allow ? "allow" : "ignore";
    }
  }
  return null;
}

function relativeTo(directory: string, absolutePath: string): string {
  return toProjectPath(path.relative(directory, absolutePath));
}

async function readLines(filePath: string): Promise<string[]> {
  try {
    return (await readFile(filePath, "utf8")).split("\n");
  } catch (error) {
    if (isIgnoredFsError(error) || (error as NodeJS.ErrnoException).code === "EISDIR") {
      return [];
    }
    throw error;
  }
}

async function gitExcludePath(directory: string): Promise<string | null> {
  const dotGit = path.join(directory, ".git");
  try {
    const dotGitStat = await stat(dotGit);
    if (dotGitStat.isDirectory()) return path.join(dotGit, "info", "exclude");
    // A linked worktree's `.git` file points at its Git directory, whose
    // `commondir` names the repository's shared Git directory.
    const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(await readFile(dotGit, "utf8"));
    if (!pointer) return null;
    const gitDir = path.resolve(directory, pointer[1]!);
    const common = (await readLines(path.join(gitDir, "commondir")))[0]?.trim();
    return path.join(common ? path.resolve(gitDir, common) : gitDir, "info", "exclude");
  } catch (error) {
    if (isIgnoredFsError(error)) return null;
    throw error;
  }
}

async function createFrame(
  directory: string,
  parent: IgnoreFrame | null,
  names: ReadonlySet<string> | null,
): Promise<IgnoreFrame> {
  const has = async (name: string): Promise<boolean> => {
    if (names !== null) return names.has(name);
    try {
      await lstat(path.join(directory, name));
      return true;
    } catch (error) {
      if (isIgnoredFsError(error)) return false;
      throw error;
    }
  };
  const [hasIgnore, hasGitignore, hasGit] = await Promise.all([
    has(".ignore"),
    has(".gitignore"),
    has(".git"),
  ]);
  const excludePath = hasGit ? await gitExcludePath(directory) : null;
  const [ignore, gitignore, gitExclude] = await Promise.all([
    hasIgnore ? readLines(path.join(directory, ".ignore")) : [],
    hasGitignore ? readLines(path.join(directory, ".gitignore")) : [],
    excludePath === null ? [] : readLines(excludePath),
  ]);
  return {
    directory,
    parent,
    ignore: compileRules(ignore),
    gitignore: compileRules(gitignore),
    gitExclude: compileRules(gitExclude),
    hasGit,
    inGit: hasGit || (parent?.inGit ?? false),
  };
}

/** Frames for a target directory and its ancestors, nearest last. */
async function ancestorFrames(directory: string): Promise<IgnoreFrame> {
  const chain: string[] = [];
  for (let current = directory; ; current = path.dirname(current)) {
    chain.unshift(current);
    if (path.dirname(current) === current) break;
  }
  let frame: IgnoreFrame | null = null;
  for (const current of chain) frame = await createFrame(current, frame, null);
  return frame!;
}

function expandHome(value: string): string {
  return value === "~" || value.startsWith("~/") || value.startsWith("~\\")
    ? path.join(os.homedir(), value.slice(1))
    : value;
}

async function globalGitignoreRules(): Promise<IgnoreRule[]> {
  const home = os.homedir();
  const xdgHome = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
  let excludesFile: string | null = null;
  // As in Git, ~/.gitconfig wins over the XDG config when both set the file.
  for (const configPath of [path.join(home, ".gitconfig"), path.join(xdgHome, "git", "config")]) {
    const text = (await readLines(configPath)).join("\n");
    const match = /^\s*excludesfile\s*=\s*(?:"([^"]*)"|([^;#\r\n]*?))\s*(?:[;#].*)?$/im.exec(text);
    const value = match?.[1] ?? match?.[2];
    if (value) {
      excludesFile = expandHome(value);
      break;
    }
  }
  return compileRules(await readLines(excludesFile ?? path.join(xdgHome, "git", "ignore")));
}

function directoryDecision(
  context: WalkContext,
  frame: IgnoreFrame,
  absolutePath: string,
  relativePath: string,
  name: string,
): boolean {
  const override = matchRules(context.overrides, relativePath, name, true);
  if (override !== null) return override === "allow";

  let ignoreMatch: RuleMatch = null;
  let gitMatch: RuleMatch = null;
  let excludeMatch: RuleMatch = null;
  let sawGit = false;
  for (let current: IgnoreFrame | null = frame; current !== null; current = current.parent) {
    const checkGit = frame.inGit && !sawGit;
    sawGit ||= current.hasGit;
    if (
      current.ignore.length === 0 &&
      (!checkGit || current.gitignore.length + current.gitExclude.length === 0)
    ) {
      continue;
    }
    const fromFrame = relativeTo(current.directory, absolutePath);
    ignoreMatch ??= matchRules(current.ignore, fromFrame, name, true);
    if (checkGit) {
      gitMatch ??= matchRules(current.gitignore, fromFrame, name, true);
      excludeMatch ??= matchRules(current.gitExclude, fromFrame, name, true);
    }
  }
  const decision =
    ignoreMatch ??
    gitMatch ??
    excludeMatch ??
    (frame.inGit ? matchRules(context.globalGitignore, relativePath, name, true) : null);
  if (decision !== null) return decision === "allow";
  return !name.startsWith(".");
}

function checkDeadline(context: WalkContext): void {
  if (Date.now() > context.deadline) throw new FileWalkTimeoutError();
}

async function walkDirectory(
  context: WalkContext,
  directory: string,
  /** Project-relative path of the directory; "" for the project root. */
  relativeDirectory: string,
  parent: IgnoreFrame | null,
): Promise<void> {
  checkDeadline(context);
  let entries: Dirent[];
  try {
    entries = await context.limit(() => readdir(directory, { withFileTypes: true }));
  } catch (error) {
    if (isIgnoredFsError(error)) return;
    throw error;
  }
  checkDeadline(context);
  const frame = parent === null
    ? await ancestorFrames(directory)
    : await context.limit(() =>
        createFrame(directory, parent, new Set(entries.map((entry) => entry.name))));
  const subdirectories: Array<[string, string]> = [];
  for (const [index, entry] of entries.entries()) {
    // A large directory's entries are checked without yielding, so the
    // deadline is checked here too.
    if ((index & 1023) === 1023) checkDeadline(context);
    const absolutePath = path.join(directory, entry.name);
    const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    let isFile = entry.isFile();
    let isDirectory = entry.isDirectory();
    if (!isFile && !isDirectory && !entry.isSymbolicLink()) {
      try {
        const entryStat = await lstat(absolutePath);
        isFile = entryStat.isFile();
        isDirectory = entryStat.isDirectory();
      } catch (error) {
        if (isIgnoredFsError(error)) continue;
        throw error;
      }
    }
    if (!isFile && !isDirectory) continue;
    if (isFile) {
      if (matchRules(context.overrides, relativePath, entry.name, false) === "allow") {
        context.files.push({ absolutePath, relativePath });
      }
    } else if (directoryDecision(context, frame, absolutePath, relativePath, entry.name)) {
      subdirectories.push([absolutePath, relativePath]);
    }
  }
  await Promise.all(
    subdirectories.map(([absolutePath, relativePath]) =>
      walkDirectory(context, absolutePath, relativePath, frame)),
  );
}

function uniqueTargets(targets: SourceTarget[]): SourceTarget[] {
  const seen = new Set<string>();
  return targets.filter((target) => {
    const key = process.platform === "win32"
      ? target.absolutePath.toLowerCase()
      : target.absolutePath;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Lists target files in no particular order; callers sort. Rejects with
 * FileWalkTimeoutError once the deadline passes.
 */
export async function walkProjectFiles(
  projectRoot: string,
  targets: SourceTarget[],
  excludes: string[],
  deadline: number,
): Promise<WalkedFile[]> {
  const context: WalkContext = {
    projectRoot,
    // Configured globs mean the opposite of ignore-file lines: a plain glob
    // includes. A leading "!" keeps an exclude such as "#tmp" from reading as
    // a comment before the rule is turned into an exclusion.
    overrides: [
      ...compileRules(SEARCH_INCLUDE_GLOBS).map((rule) => ({ ...rule, allow: true })),
      ...compileRules(
        excludes.map((exclude) => `!${exclude.replace(/^!+/, "").replaceAll("\\", "/")}`),
      ).map((rule) => ({ ...rule, allow: false })),
    ],
    globalGitignore: [],
    deadline,
    limit: createLimiter(WALK_CONCURRENCY),
    files: [],
  };
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new FileWalkTimeoutError()),
      Math.max(1, deadline - Date.now()),
    );
  });
  const work = (async () => {
    context.globalGitignore = await globalGitignoreRules();
    await Promise.all(
      uniqueTargets(targets).map(async (target) => {
        if (target.isDirectory) {
          await walkDirectory(
            context,
            target.absolutePath,
            relativeTo(projectRoot, target.absolutePath),
            null,
          );
        } else {
          context.files.push({
            absolutePath: target.absolutePath,
            relativePath: relativeTo(projectRoot, target.absolutePath),
          });
        }
      }),
    );
    return context.files;
  })();
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
    // The losing walk stops at its next deadline check.
    work.catch(() => undefined);
  }
}
