import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  ImpactAdapterError,
  type ImpactAdapter,
  type ImpactAdapterRequest,
  type ImpactAdapterResponse,
} from "project-context-mcp/impact-adapter";

const execFileAsync = promisify(execFile);
const HASH = /^[a-f0-9]{40}$/u;

async function git(projectRoot: string, args: string[]): Promise<string> {
  try {
    const result = await execFileAsync(process.platform === "win32" ? "git.exe" : "git", args, {
      cwd: projectRoot,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    return result.stdout;
  } catch (error) {
    throw new ImpactAdapterError(
      error instanceof Error ? error.message : String(error),
      "unavailable",
    );
  }
}

export function createGitImpactAdapter(runGit = git): ImpactAdapter {
  return {
    name: "project-context-mcp-git",
    language: "git",
    async probe() {
      try {
        const version = (await runGit(process.cwd(), ["--version"])).trim();
        return { available: true, detail: `${version} is available`, version };
      } catch (error) {
        return { available: false, detail: error instanceof Error ? error.message : String(error) };
      }
    },
    async analyze(request: ImpactAdapterRequest): Promise<ImpactAdapterResponse> {
      const startedAt = Date.now();
      const history = await runGit(request.projectRoot, [
        "log", `--max-count=${request.historyLimit}`, "--format=%H%x09%cI", "--", request.target,
      ]);
      const commits = history.split(/\r?\n/u)
        .map((line) => line.split("\t"))
        .filter((entry): entry is [string, string] => HASH.test(entry[0] ?? "") && Boolean(entry[1]));
      const impacts = new Map<string, { count: number; lastChangedAt: string; commits: string[] }>();
      for (const [hash, changedAt] of commits) {
        const changed = await runGit(request.projectRoot, ["diff-tree", "--no-commit-id", "--name-only", "-r", hash]);
        for (const rawPath of changed.split(/\r?\n/u)) {
          const filePath = rawPath.trim().replaceAll("\\", "/");
          if (!filePath || filePath === request.target) continue;
          const current = impacts.get(filePath) ?? { count: 0, lastChangedAt: changedAt, commits: [] };
          current.count += 1;
          if (changedAt > current.lastChangedAt) current.lastChangedAt = changedAt;
          if (current.commits.length < 5) current.commits.push(hash);
          impacts.set(filePath, current);
        }
      }
      const ordered = [...impacts.entries()]
        .map(([path, value]) => ({ path, cochangeCount: value.count, lastChangedAt: value.lastChangedAt, commits: value.commits }))
        .sort((left, right) => right.cochangeCount - left.cochangeCount || right.lastChangedAt.localeCompare(left.lastChangedAt) || left.path.localeCompare(right.path));
      return {
        workerVersion: "git-history/1.0.0",
        target: request.target,
        commitsAnalyzed: commits.length,
        results: ordered.slice(0, request.maxResults),
        truncated: ordered.length > request.maxResults,
        diagnostics: { elapsedMs: Date.now() - startedAt, messages: [] },
      };
    },
  };
}

export const impactAdapter = createGitImpactAdapter();
