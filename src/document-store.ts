import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

import { loadProjectConfig } from "./config.js";
import { resolvePathInsideProject, resolveProjectRoot } from "./project-path.js";
import type { DocumentReadResult } from "./result-format.js";
import {
  classifySource,
  isAllowedTextFile,
  isExcluded,
  resolveSourceTargets,
} from "./source-policy.js";

const MAX_READ_LINES = 400;
const DEFAULT_READ_LINES = 200;
const MAX_READ_CHARACTERS = 200_000;

export async function readProjectDocument(input: {
  projectPath: string;
  path: string;
  startLine?: number;
  endLine?: number;
}): Promise<DocumentReadResult> {
  const startLine = input.startLine ?? 1;
  const requestedEndLine = input.endLine ?? startLine + DEFAULT_READ_LINES - 1;
  if (!Number.isInteger(startLine) || startLine < 1) {
    throw new Error("startLine must be a positive integer");
  }
  if (!Number.isInteger(requestedEndLine) || requestedEndLine < startLine) {
    throw new Error("endLine must be an integer greater than or equal to startLine");
  }
  if (requestedEndLine - startLine + 1 > MAX_READ_LINES) {
    throw new Error(`A single read is limited to ${MAX_READ_LINES} lines`);
  }

  const project = await resolveProjectRoot(input.projectPath);
  const loadedConfig = await loadProjectConfig(project.root);
  if (!loadedConfig.exists) {
    throw new Error(`Project config not found: ${loadedConfig.path}`);
  }
  if (!loadedConfig.valid) {
    throw new Error(`Invalid project config: ${loadedConfig.errors.join("; ")}`);
  }
  const resolved = await resolvePathInsideProject(project.root, input.path, true);
  if (!isAllowedTextFile(resolved.relativePath)) {
    throw new Error("Only configured text/code file types can be read");
  }
  if (isExcluded(resolved.relativePath, loadedConfig.value.exclude)) {
    throw new Error("Path is excluded by project configuration");
  }

  const targets = await resolveSourceTargets(project.root, loadedConfig.value, "all");
  const source = classifySource(resolved.absolutePath, targets);
  if (source === null) {
    throw new Error("Path is outside configured project sources");
  }

  const stream = createReadStream(resolved.absolutePath, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const selected: string[] = [];
  let currentLine = 0;
  let characterCount = 0;
  try {
    for await (const line of lines) {
      currentLine += 1;
      if (currentLine < startLine) continue;
      if (currentLine > requestedEndLine) break;
      characterCount += line.length;
      if (characterCount > MAX_READ_CHARACTERS) {
        throw new Error(
          `Selected range exceeds ${MAX_READ_CHARACTERS} characters`,
        );
      }
      selected.push(line);
    }
  } finally {
    lines.close();
    stream.destroy();
  }

  if (selected.length === 0) {
    throw new Error(`startLine ${startLine} is beyond the end of the file`);
  }
  const lineEnd = startLine + selected.length - 1;
  return {
    source,
    path: resolved.relativePath,
    matchKind: "content",
    lineStart: startLine,
    lineEnd,
    requestedEndLine,
    text: selected.join("\n"),
    score: null,
    indexedAt: null,
    commit: project.commit,
  };
}
