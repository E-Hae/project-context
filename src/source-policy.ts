import path from "node:path";

import { Minimatch } from "minimatch";

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
  ".controller",
  ".asmdef",
  ".asmref",
  ".c",
  ".cjs",
  ".cs",
  ".cpp",
  ".go",
  ".h",
  ".hpp",
  ".java",
  ".js",
  ".jsx",
  ".json",
  ".jsonc",
  ".kt",
  ".md",
  ".mjs",
  ".meta",
  ".php",
  ".prefab",
  ".py",
  ".rb",
  ".rs",
  ".toml",
  ".unity",
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
  "*.controller",
  "*.asmdef",
  "*.asmref",
  "*.c",
  "*.cjs",
  "*.cs",
  "*.cpp",
  "*.go",
  "*.h",
  "*.hpp",
  "*.java",
  "*.js",
  "*.jsx",
  "*.json",
  "*.jsonc",
  "*.kt",
  "*.md",
  "*.mjs",
  "*.meta",
  "*.php",
  "*.prefab",
  "*.py",
  "*.rb",
  "*.rs",
  "*.toml",
  "*.unity",
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

const targetKeys = new WeakMap<SourceTarget, string>();

function targetKey(target: SourceTarget): string {
  let key = targetKeys.get(target);
  if (key === undefined) {
    key = pathKey(target.absolutePath);
    targetKeys.set(target, key);
  }
  return key;
}

/** Whether a path key from pathKey() lies in a target. */
function isInside(target: SourceTarget, key: string): boolean {
  const base = targetKey(target);
  if (key === base) return true;
  if (!target.isDirectory) return false;
  return key.startsWith(base.endsWith(path.sep) ? base : `${base}${path.sep}`);
}

export function isAllowedTextFile(relativePath: string): boolean {
  return ALLOWED_TEXT_EXTENSIONS.has(path.extname(relativePath).toLowerCase());
}

const excludeMatchers = new Map<string, Minimatch>();

function excludeMatcher(pattern: string): Minimatch {
  let matcher = excludeMatchers.get(pattern);
  if (matcher === undefined) {
    const normalizedPattern = pattern.replaceAll("\\", "/").replace(/^\/+/, "");
    matcher = new Minimatch(normalizedPattern, {
      dot: true,
      nocase: process.platform === "win32",
      optimizationLevel: 2,
    });
    excludeMatchers.set(pattern, matcher);
  }
  return matcher;
}

export function isExcluded(
  relativePath: string,
  patterns: string[],
): boolean {
  return patterns.some((pattern) => excludeMatcher(pattern).match(relativePath));
}

/** Index of the first configured target that contains a path, or -1. */
export function sourceTargetIndex(
  absolutePath: string,
  targets: SourceTarget[],
): number {
  const key = pathKey(absolutePath);
  return targets.findIndex((target) => isInside(target, key));
}

export function classifySource(
  absolutePath: string,
  targets: SourceTarget[],
): SourceKind | null {
  const key = pathKey(absolutePath);
  const matching = targets.filter((target) => isInside(target, key));
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
