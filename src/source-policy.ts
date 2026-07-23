import path from "node:path";

import { minimatch } from "minimatch";

import type { ProjectContextConfig } from "./config.js";
import {
  ProjectPathError,
  resolvePathInsideProject,
} from "./project-path.js";

export type SearchScope = "all" | "code" | "documents";
export type SourceKind = "code" | "document";

export interface SourceTarget {
  source: SourceKind;
  absolutePath: string;
  relativePath: string;
  isDirectory: boolean;
}

const ALLOWED_TEXT_EXTENSIONS = new Set([
  ".asset",
  ".asmdef",
  ".asmref",
  ".c",
  ".cs",
  ".cpp",
  ".go",
  ".h",
  ".hpp",
  ".java",
  ".js",
  ".json",
  ".jsonc",
  ".kt",
  ".md",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".uss",
  ".uxml",
  ".yaml",
  ".yml",
]);

export const SEARCH_INCLUDE_GLOBS = [
  "*.asset",
  "*.asmdef",
  "*.asmref",
  "*.c",
  "*.cs",
  "*.cpp",
  "*.go",
  "*.h",
  "*.hpp",
  "*.java",
  "*.js",
  "*.json",
  "*.jsonc",
  "*.kt",
  "*.md",
  "*.php",
  "*.py",
  "*.rb",
  "*.rs",
  "*.toml",
  "*.ts",
  "*.tsx",
  "*.txt",
  "*.uss",
  "*.uxml",
  "*.yaml",
  "*.yml",
];

function pathKey(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isInside(target: SourceTarget, absolutePath: string): boolean {
  const targetKey = pathKey(target.absolutePath);
  const pathValue = pathKey(absolutePath);
  if (!target.isDirectory) {
    return targetKey === pathValue;
  }
  const relative = path.relative(targetKey, pathValue);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

export function isAllowedTextFile(relativePath: string): boolean {
  return ALLOWED_TEXT_EXTENSIONS.has(path.extname(relativePath).toLowerCase());
}

export function isExcluded(
  relativePath: string,
  patterns: string[],
): boolean {
  return patterns.some((pattern) => {
    const normalizedPattern = pattern.replaceAll("\\", "/").replace(/^\/+/, "");
    return minimatch(relativePath, normalizedPattern, {
      dot: true,
      nocase: process.platform === "win32",
      optimizationLevel: 2,
    });
  });
}

export function classifySource(
  absolutePath: string,
  targets: SourceTarget[],
): SourceKind | null {
  const matching = targets.filter((target) => isInside(target, absolutePath));
  if (matching.some((target) => target.source === "document")) {
    return "document";
  }
  return matching.some((target) => target.source === "code") ? "code" : null;
}

export async function resolveSourceTargets(
  projectRoot: string,
  config: ProjectContextConfig,
  scope: SearchScope,
): Promise<SourceTarget[]> {
  const entries: Array<{ source: SourceKind; value: string }> = [];
  if (scope === "all" || scope === "code") {
    entries.push(
      ...config.sources.code.map((value) => ({ source: "code" as const, value })),
    );
  }
  if (scope === "all" || scope === "documents") {
    entries.push(
      ...config.sources.documents.map((value) => ({
        source: "document" as const,
        value,
      })),
    );
  }

  const targets: SourceTarget[] = [];
  for (const entry of entries) {
    try {
      const resolved = await resolvePathInsideProject(projectRoot, entry.value);
      targets.push({ source: entry.source, ...resolved });
    } catch (error) {
      if (error instanceof ProjectPathError && error.code === "not_found") {
        continue;
      }
      throw error;
    }
  }
  return targets;
}
