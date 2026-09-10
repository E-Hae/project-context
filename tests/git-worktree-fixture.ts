import { execFile } from "node:child_process";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface LinkedWorktreeFixture {
  mainRoot: string;
  worktreeRoot: string;
  mainCommit: string;
  worktreeCommit: string;
}

export async function gitAvailable(): Promise<boolean> {
  try {
    await run("git", ["--version"], { windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run(
    "git",
    ["-c", `safe.directory=${cwd}`, "-C", cwd, ...args],
    { windowsHide: true },
  );
  return stdout.trim();
}

async function writeFiles(
  root: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [relativePath, contents] of Object.entries(files)) {
    const target = path.join(root, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents, "utf8");
  }
}

export interface LinkedWorktreeOptions {
  /** Files committed on the linked branch alone, diverging its HEAD commit. */
  worktreeFiles?: Record<string, string>;
  /** Worktree location relative to the main root; defaults to `.worktrees/feature`. */
  worktreePath?: string;
}

/**
 * Creates `<root>/main` holding one commit of `files`, then links a worktree
 * inside it. Both trees share `files`; only the linked branch gets any
 * `worktreeFiles`, so their HEAD commits differ.
 */
export async function createLinkedWorktree(
  root: string,
  files: Record<string, string>,
  options: LinkedWorktreeOptions = {},
): Promise<LinkedWorktreeFixture> {
  const worktreeFiles = options.worktreeFiles ?? {};
  const worktreePath = options.worktreePath ?? path.join(".worktrees", "feature");
  const mainRoot = path.join(root, "main");
  await mkdir(mainRoot, { recursive: true });
  await git(mainRoot, "init", "-q", ".");
  await git(mainRoot, "config", "user.email", "fixture@example.com");
  await git(mainRoot, "config", "user.name", "fixture");
  await git(mainRoot, "config", "core.autocrlf", "false");
  await writeFiles(mainRoot, files);
  await git(mainRoot, "add", "-A");
  await git(mainRoot, "commit", "-q", "-m", "fixture");
  await git(mainRoot, "branch", "-q", "feature");
  await git(mainRoot, "worktree", "add", "-q", worktreePath, "feature");

  const worktreeRoot = path.join(mainRoot, worktreePath);
  if (Object.keys(worktreeFiles).length > 0) {
    await writeFiles(worktreeRoot, worktreeFiles);
    await git(worktreeRoot, "add", "-A");
    await git(worktreeRoot, "commit", "-q", "-m", "fixture branch");
  }

  return {
    mainRoot: await realpath(mainRoot),
    worktreeRoot: await realpath(worktreeRoot),
    mainCommit: await git(mainRoot, "rev-parse", "HEAD"),
    worktreeCommit: await git(worktreeRoot, "rev-parse", "HEAD"),
  };
}
