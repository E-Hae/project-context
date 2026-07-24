import path from "node:path";

import { loadProjectConfig } from "./config.js";
import { resolveImpactAdapter } from "./impact-adapter-resolver.js";
import { resolvePathInsideProject, resolveProjectRoot } from "./project-path.js";
import { isAllowedTextFile, isExcluded } from "./source-policy.js";

export interface ImpactResult {
  route: "impact";
  target: string;
  language: string;
  commit: string | null;
  analyzedAt: string;
  workerVersion: string;
  commitsAnalyzed: number;
  results: Array<{ path: string; cochangeCount: number; lastChangedAt: string | null; commits: string[] }>;
  truncated: boolean;
  diagnostics: { elapsedMs: number; messages: string[] };
}

export async function analyzeProjectImpact(input: {
  projectPath: string;
  target: string;
  maxResults?: number;
  language?: string;
}): Promise<ImpactResult> {
  const project = await resolveProjectRoot(input.projectPath);
  const loaded = await loadProjectConfig(project.root);
  if (!loaded.valid) throw new Error(`Project configuration is invalid: ${loaded.errors.join("; ")}`);
  const checked = await resolvePathInsideProject(project.root, input.target, true);
  if (!isAllowedTextFile(checked.relativePath) || isExcluded(checked.relativePath, loaded.value.exclude)) {
    throw new Error(`Impact target is not an allowed project source: ${input.target}`);
  }
  const maxResults = input.maxResults ?? 50;
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 200) {
    throw new Error("maxResults must be between 1 and 200");
  }
  const adapter = await resolveImpactAdapter(input.language);
  const response = await adapter.analyze({
    projectRoot: project.root,
    target: checked.relativePath.replaceAll(path.sep, "/"),
    maxResults,
    historyLimit: loaded.value.adapters.git.historyLimit,
  });
  return {
    route: "impact",
    target: response.target,
    language: adapter.language,
    commit: project.commit,
    analyzedAt: new Date().toISOString(),
    workerVersion: response.workerVersion,
    commitsAnalyzed: response.commitsAnalyzed,
    results: response.results,
    truncated: response.truncated,
    diagnostics: response.diagnostics,
  };
}
