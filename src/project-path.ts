import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";

export class ProjectPathError extends Error {
  constructor(
    message: string,
    readonly code:
      | "invalid_project"
      | "not_found"
      | "outside_project"
      | "not_file",
  ) {
    super(message);
    this.name = "ProjectPathError";
  }
}

interface CommandResult {
  ok: boolean;
  stdout: string;
}

export interface ResolvedProject {
  requestedPath: string;
  root: string;
  commit: string | null;
}

export interface ResolvedProjectPath {
  absolutePath: string;
  relativePath: string;
  isDirectory: boolean;
}

function runGit(args: string[], timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        timeout: timeoutMs,
        windowsHide: true,
      },
      (error, stdout) => {
        resolve({
          ok: error === null,
          stdout: stdout.trim(),
        });
      },
    );
  });
}

function gitArgs(root: string, ...args: string[]): string[] {
  return ["-c", `safe.directory=${root}`, "-C", root, ...args];
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

export function toProjectPath(value: string): string {
  return value.split(path.sep).join("/");
}

export async function resolveProjectRoot(
  projectPath: string,
  timeoutMs = 2_000,
): Promise<ResolvedProject> {
  if (!projectPath.trim() || projectPath.includes("\0")) {
    throw new ProjectPathError("Project path is empty or invalid", "invalid_project");
  }

  const requestedPath = path.resolve(projectPath);
  let root: string;
  try {
    const projectStat = await stat(requestedPath);
    if (!projectStat.isDirectory()) {
      throw new ProjectPathError(
        "Project path is not a directory",
        "invalid_project",
      );
    }
    root = await realpath(requestedPath);
  } catch (error) {
    if (error instanceof ProjectPathError) {
      throw error;
    }
    throw new ProjectPathError(
      "Project path does not exist or cannot be resolved",
      "invalid_project",
    );
  }

  const gitRoot = await runGit(
    gitArgs(root, "rev-parse", "--show-toplevel"),
    timeoutMs,
  );
  if (gitRoot.ok && gitRoot.stdout) {
    try {
      root = await realpath(gitRoot.stdout);
    } catch {
      root = path.resolve(gitRoot.stdout);
    }
  }

  return {
    requestedPath,
    root,
    commit: await resolveHeadCommit(root, timeoutMs),
  };
}

export async function resolveHeadCommit(
  root: string,
  timeoutMs = 2_000,
): Promise<string | null> {
  const commit = await runGit(gitArgs(root, "rev-parse", "HEAD"), timeoutMs);
  return commit.ok && commit.stdout ? commit.stdout : null;
}

export function normalizePathForComparison(value: string): string {
  return path.normalize(value).replace(/[\\/]+$/, "").toLocaleLowerCase("en-US");
}

export function parseMainWorktreeRoot(
  porcelain: string,
  root: string,
): string | null {
  // `git worktree list --porcelain` reports the main worktree first. A bare
  // repository has no main working tree, so it can share no index.
  const firstBlock = porcelain.replaceAll("\r\n", "\n").split("\n\n")[0] ?? "";
  const lines = firstBlock.split("\n");
  if (lines.some((line) => line.trim() === "bare")) return null;
  const listed = lines.find((line) => line.startsWith("worktree "));
  if (listed === undefined) return null;
  const mainRoot = listed.slice("worktree ".length).trim();
  if (
    !mainRoot ||
    normalizePathForComparison(mainRoot) === normalizePathForComparison(root)
  ) {
    return null;
  }
  return mainRoot;
}

/**
 * Returns the main worktree root when `projectRoot` is a linked worktree, and
 * null when it is the main worktree, a bare repository, or not a repository.
 */
export async function resolveMainWorktreeRoot(
  projectRoot: string,
  timeoutMs = 2_000,
): Promise<string | null> {
  const listed = await runGit(
    gitArgs(projectRoot, "worktree", "list", "--porcelain"),
    timeoutMs,
  );
  if (!listed.ok || !listed.stdout) return null;
  const mainRoot = parseMainWorktreeRoot(listed.stdout, projectRoot);
  if (mainRoot === null) return null;
  try {
    return await realpath(mainRoot);
  } catch {
    return path.resolve(mainRoot);
  }
}

export async function resolveIndexRoot(
  projectRoot: string,
  reuseMainWorktree: boolean,
  timeoutMs = 2_000,
): Promise<string> {
  if (!reuseMainWorktree) return projectRoot;
  return (await resolveMainWorktreeRoot(projectRoot, timeoutMs)) ?? projectRoot;
}

export async function resolvePathInsideProject(
  projectRoot: string,
  candidatePath: string,
  requireFile = false,
): Promise<ResolvedProjectPath> {
  if (!candidatePath.trim() || candidatePath.includes("\0")) {
    throw new ProjectPathError("Path is empty or invalid", "not_found");
  }

  const root = await realpath(projectRoot);
  const candidate = path.isAbsolute(candidatePath)
    ? path.resolve(candidatePath)
    : path.resolve(root, candidatePath);

  if (!isInside(root, candidate)) {
    throw new ProjectPathError(
      "Path escapes the project root",
      "outside_project",
    );
  }

  let resolved: string;
  let candidateStat;
  try {
    resolved = await realpath(candidate);
    candidateStat = await stat(resolved);
  } catch {
    throw new ProjectPathError("Path does not exist", "not_found");
  }

  if (!isInside(root, resolved)) {
    throw new ProjectPathError(
      "Resolved path escapes the project root",
      "outside_project",
    );
  }
  if (requireFile && !candidateStat.isFile()) {
    throw new ProjectPathError("Path is not a file", "not_file");
  }

  return {
    absolutePath: resolved,
    relativePath: toProjectPath(path.relative(root, resolved)),
    isDirectory: candidateStat.isDirectory(),
  };
}
