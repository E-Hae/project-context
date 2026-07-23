import {
  link,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";

import { parse as parseYaml } from "yaml";

import { resolveProjectRoot } from "./project-path.js";

export const DEFAULT_HANDOFF_ROOT = path.join(
  homedir(),
  ".agents",
  "handoff",
);

const LABEL_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
const PROJECT_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VIRTUAL_HANDOFF_PATTERN = /^@handoff\/([^/]+)\/([^/]+)\.md$/;

export class HandoffStoreError extends Error {
  constructor(
    message: string,
    readonly code:
      | "invalid_label"
      | "invalid_target"
      | "invalid_content"
      | "not_found"
      | "ambiguous"
      | "already_exists"
      | "write_conflict"
      | "write_failed",
  ) {
    super(message);
    this.name = "HandoffStoreError";
  }
}

export interface HandoffDocumentMetadata {
  projectSlug: string;
  projectPath: string;
  projectFolderPath: string;
  label: string;
  documentId: string;
  title: string;
  date: string | null;
  path: string;
  modifiedAt: string;
}

export interface HandoffDocument extends HandoffDocumentMetadata {
  content: string;
}

export interface HandoffWriteResult extends HandoffDocument {
  operation: "created" | "replaced" | "appended";
}

export interface HandoffProjectListing {
  projectSlug: string;
  projectPath: string;
  projectFolderPath: string;
  documents: HandoffDocumentMetadata[];
}

export interface HandoffListResult {
  scope: "project" | "all";
  projects: HandoffProjectListing[];
  totalProjects: number;
  totalDocuments: number;
}

interface RegisteredHandoffProject {
  projectSlug: string;
  projectPath: string;
  projectFolderPath: string;
}

export interface HandoffTarget {
  projectPath?: string;
  projectSlug?: string;
}

export interface HandoffSaveInput extends HandoffTarget {
  label: string;
  content: string;
}

export interface HandoffUpdateInput extends HandoffSaveInput {
  mode?: "replace" | "append";
}

function pathKey(value: string): string {
  return value
    .trim()
    .replaceAll("\\", "/")
    .replace(/\/+$/, "")
    .toLocaleLowerCase("en-US");
}

function isInside(root: string, candidate: string): boolean {
  const rootValue = process.platform === "win32" ? root.toLowerCase() : root;
  const candidateValue =
    process.platform === "win32" ? candidate.toLowerCase() : candidate;
  const relative = path.relative(rootValue, candidateValue);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function validateLabel(label: string): void {
  if (!LABEL_PATTERN.test(label)) {
    throw new HandoffStoreError(
      "Handoff label must contain lowercase words separated by underscores",
      "invalid_label",
    );
  }
}

function validateProjectSlug(projectSlug: string): void {
  if (!PROJECT_SLUG_PATTERN.test(projectSlug)) {
    throw new HandoffStoreError(
      "Handoff project slug must contain lowercase words separated by hyphens",
      "invalid_target",
    );
  }
}

async function resolvedHandoffRoot(handoffRoot: string): Promise<string> {
  try {
    const resolved = await realpath(handoffRoot);
    if (!(await stat(resolved)).isDirectory()) throw new Error("not a directory");
    return resolved;
  } catch {
    throw new HandoffStoreError(
      `Handoff root does not exist or cannot be read: ${handoffRoot}`,
      "not_found",
    );
  }
}

async function writableHandoffRoot(handoffRoot: string): Promise<string> {
  try {
    await mkdir(handoffRoot, { recursive: true });
    const resolved = await realpath(handoffRoot);
    if (!(await stat(resolved)).isDirectory()) throw new Error("not a directory");
    return resolved;
  } catch {
    throw new HandoffStoreError(
      `Handoff root cannot be created or written: ${handoffRoot}`,
      "write_failed",
    );
  }
}

async function registeredProjects(
  handoffRoot: string,
): Promise<RegisteredHandoffProject[]> {
  const root = await resolvedHandoffRoot(handoffRoot);
  const entries = await readdir(root, { withFileTypes: true });
  const projects: RegisteredHandoffProject[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || !PROJECT_SLUG_PATTERN.test(entry.name)) continue;
    const candidateFolder = path.join(root, entry.name);
    try {
      const projectFolderPath = await realpath(candidateFolder);
      if (!isInside(root, projectFolderPath)) continue;
      const projectPath = (
        await readFile(path.join(projectFolderPath, ".project-path"), "utf8")
      ).trim();
      if (!projectPath || projectPath.includes("\0")) continue;
      projects.push({
        projectSlug: entry.name,
        projectPath,
        projectFolderPath,
      });
    } catch {
      // Only folders with a readable marker are registered handoff projects.
    }
  }

  return projects.sort((left, right) =>
    left.projectSlug.localeCompare(right.projectSlug, "en"),
  );
}

async function projectRootWithWorktreeGuard(projectPath: string): Promise<string> {
  const project = await resolveProjectRoot(projectPath);
  const normalized = project.root.replaceAll("\\", "/");
  const worktreeSegment = normalized.toLocaleLowerCase("en-US").indexOf("/.worktrees/");
  if (worktreeSegment < 0) return project.root;

  const mainRoot = normalized.slice(0, worktreeSegment);
  try {
    return await realpath(mainRoot);
  } catch {
    return path.resolve(mainRoot);
  }
}

async function resolveTargetProject(
  target: HandoffTarget,
  handoffRoot: string,
): Promise<RegisteredHandoffProject> {
  const projects = await registeredProjects(handoffRoot);
  let projectRoot: string | null = null;
  if (target.projectPath !== undefined) {
    projectRoot = await projectRootWithWorktreeGuard(target.projectPath);
  }
  if (target.projectSlug !== undefined) validateProjectSlug(target.projectSlug);

  const matches = projects.filter((project) => {
    if (
      target.projectSlug !== undefined &&
      project.projectSlug.toLocaleLowerCase("en-US") !==
        target.projectSlug.toLocaleLowerCase("en-US")
    ) {
      return false;
    }
    return projectRoot === null || pathKey(project.projectPath) === pathKey(projectRoot);
  });

  if (matches.length === 0) {
    throw new HandoffStoreError(
      "No registered handoff project matches the requested project",
      "not_found",
    );
  }
  if (matches.length > 1) {
    throw new HandoffStoreError(
      "Multiple handoff project folders match the requested project",
      "ambiguous",
    );
  }
  return matches[0]!;
}

function projectSlugForPath(projectRoot: string): string {
  const slug = path
    .basename(projectRoot)
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) {
    throw new HandoffStoreError(
      "Project path cannot be converted to a handoff project slug",
      "invalid_target",
    );
  }
  return slug;
}

async function resolveWritableTargetProject(
  target: HandoffTarget,
  handoffRoot: string,
): Promise<RegisteredHandoffProject> {
  const root = await writableHandoffRoot(handoffRoot);
  if (target.projectSlug !== undefined) validateProjectSlug(target.projectSlug);
  if (target.projectPath === undefined && target.projectSlug !== undefined) {
    return resolveTargetProject(target, root);
  }

  const projectRoot = await projectRootWithWorktreeGuard(
    target.projectPath ?? process.cwd(),
  );
  const projects = await registeredProjects(root);
  const matches = projects.filter(
    (project) =>
      pathKey(project.projectPath) === pathKey(projectRoot) &&
      (target.projectSlug === undefined ||
        project.projectSlug.toLocaleLowerCase("en-US") ===
          target.projectSlug.toLocaleLowerCase("en-US")),
  );
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new HandoffStoreError(
      "Multiple handoff project folders match the requested project",
      "ambiguous",
    );
  }
  if (target.projectSlug !== undefined) {
    throw new HandoffStoreError(
      "A new handoff project cannot be created with an explicit project slug",
      "invalid_target",
    );
  }

  const baseSlug = projectSlugForPath(projectRoot);
  for (let suffix = 1; ; suffix += 1) {
    const projectSlug = suffix === 1 ? baseSlug : `${baseSlug}-${suffix}`;
    const projectFolder = path.join(root, projectSlug);
    try {
      await mkdir(projectFolder);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw new HandoffStoreError(
        `Handoff project folder cannot be created: ${projectFolder}`,
        "write_failed",
      );
    }

    try {
      const projectFolderPath = await realpath(projectFolder);
      if (!isInside(root, projectFolderPath)) {
        throw new HandoffStoreError(
          "Created handoff project folder resolves outside the handoff root",
          "write_failed",
        );
      }
      await writeFile(
        path.join(projectFolderPath, ".project-path"),
        `${projectRoot}\n`,
        { encoding: "utf8", flag: "wx" },
      );
      return { projectSlug, projectPath: projectRoot, projectFolderPath };
    } catch (error) {
      if (error instanceof HandoffStoreError) throw error;
      throw new HandoffStoreError(
        `Handoff project marker cannot be written: ${projectFolder}`,
        "write_failed",
      );
    }
  }
}

function normalizeMarkdown(content: string): string {
  if (!content.trim() || content.includes("\0")) {
    throw new HandoffStoreError(
      "Handoff content is empty or invalid",
      "invalid_content",
    );
  }
  return content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

function normalizeDocument(content: string): { content: string; date: string } {
  const normalized = normalizeMarkdown(content);
  const lines = normalized.split("\n");
  if (lines[0] !== "---") {
    throw new HandoffStoreError(
      "Handoff documents must begin with YAML frontmatter",
      "invalid_content",
    );
  }
  const end = lines.indexOf("---", 1);
  if (end <= 1) {
    throw new HandoffStoreError(
      "Handoff document frontmatter is incomplete",
      "invalid_content",
    );
  }

  let frontmatter: Record<string, unknown>;
  try {
    const parsed = parseYaml(lines.slice(1, end).join("\n"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    frontmatter = parsed as Record<string, unknown>;
  } catch {
    throw new HandoffStoreError(
      "Handoff document frontmatter is invalid YAML",
      "invalid_content",
    );
  }

  if (typeof frontmatter.title !== "string" || !frontmatter.title.trim()) {
    throw new HandoffStoreError(
      "Handoff document frontmatter requires a title",
      "invalid_content",
    );
  }
  if (
    typeof frontmatter.date !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(frontmatter.date)
  ) {
    throw new HandoffStoreError(
      "Handoff document frontmatter requires a YYYY-MM-DD date",
      "invalid_content",
    );
  }
  if (!lines.slice(end + 1).join("\n").trim()) {
    throw new HandoffStoreError(
      "Handoff document requires a non-empty body",
      "invalid_content",
    );
  }
  return {
    content: normalized.endsWith("\n") ? normalized : `${normalized}\n`,
    date: frontmatter.date,
  };
}

function appendBody(content: string, documentTitle: string): string {
  const normalized = normalizeMarkdown(content);
  let lines = normalized.split("\n");
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1);
    if (end <= 1) {
      throw new HandoffStoreError(
        "Appended handoff frontmatter is incomplete",
        "invalid_content",
      );
    }
    try {
      parseYaml(lines.slice(1, end).join("\n"));
    } catch {
      throw new HandoffStoreError(
        "Appended handoff frontmatter is invalid YAML",
        "invalid_content",
      );
    }
    lines = lines.slice(end + 1);
  }
  while (lines[0]?.trim() === "") lines = lines.slice(1);
  const heading = lines[0]?.match(/^#\s+(.+?)\s*#*\s*$/)?.[1]?.trim();
  if (heading === documentTitle.trim()) lines = lines.slice(1);

  const body = lines.join("\n").trim();
  if (!body) {
    throw new HandoffStoreError(
      "Handoff append content requires a non-empty body",
      "invalid_content",
    );
  }
  return body;
}

function appendToDocument(
  document: HandoffDocument,
  content: string,
): string {
  const newline = document.content.includes("\r\n") ? "\r\n" : "\n";
  const body = appendBody(content, document.title).replaceAll("\n", newline);
  const prefix = document.content.endsWith("\n")
    ? document.content
    : `${document.content}${newline}`;
  return `${prefix}${body}${newline}`;
}

function preserveDocumentDate(content: string, date: string): string {
  const lines = content.split("\n");
  const end = lines.indexOf("---", 1);
  const dateLine = lines.findIndex(
    (line, index) =>
      index > 0 &&
      index < end &&
      /^\s*(?:date|["']date["'])\s*:/.test(line),
  );
  if (dateLine < 0) {
    throw new HandoffStoreError(
      "Handoff document date cannot be preserved",
      "invalid_content",
    );
  }
  const prefix = lines[dateLine]!.match(
    /^(\s*(?:date|["']date["'])\s*:\s*)/,
  )?.[1];
  if (prefix === undefined) {
    throw new HandoffStoreError(
      "Handoff document date cannot be preserved",
      "invalid_content",
    );
  }
  lines[dateLine] = `${prefix}${date}`;
  return lines.join("\n");
}

function temporaryPath(destination: string): string {
  return path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${process.pid}.${randomUUID()}.tmp`,
  );
}

async function writeNewDocument(destination: string, content: string): Promise<void> {
  const temporary = temporaryPath(destination);
  try {
    try {
      await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
    } catch {
      throw new HandoffStoreError(
        `Handoff document cannot be created: ${path.basename(destination)}`,
        "write_failed",
      );
    }
    try {
      await link(temporary, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new HandoffStoreError(
          `Handoff document already exists: ${path.basename(destination)}`,
          "already_exists",
        );
      }
      throw new HandoffStoreError(
        `Handoff document cannot be created: ${path.basename(destination)}`,
        "write_failed",
      );
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function replaceDocument(destination: string, content: string): Promise<void> {
  const temporary = temporaryPath(destination);
  try {
    try {
      await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
      await rename(temporary, destination);
    } catch {
      throw new HandoffStoreError(
        `Handoff document cannot be updated: ${path.basename(destination)}`,
        "write_failed",
      );
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function withDocumentLock<T>(
  destination: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lockPath = `${destination}.lock`;
  let lock;
  try {
    lock = await open(lockPath, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new HandoffStoreError(
        `Handoff document is already being updated: ${path.basename(destination)}`,
        "write_conflict",
      );
    }
    throw new HandoffStoreError(
      `Handoff document cannot be locked: ${path.basename(destination)}`,
      "write_failed",
    );
  }
  try {
    return await operation();
  } finally {
    await lock.close().catch(() => undefined);
    await rm(lockPath, { force: true }).catch(() => undefined);
  }
}

function parseMetadata(content: string, label: string): {
  title: string;
  date: string | null;
} {
  const normalized = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  let frontmatter: Record<string, unknown> | null = null;
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1);
    if (end > 1) {
      try {
        const parsed = parseYaml(lines.slice(1, end).join("\n"));
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          frontmatter = parsed as Record<string, unknown>;
        }
      } catch {
        // A malformed frontmatter block does not make the plain Markdown unreadable.
      }
    }
  }

  const heading = normalized.match(/^#\s+(.+?)\s*#*\s*$/m)?.[1]?.trim();
  const rawTitle = frontmatter?.title;
  const title =
    typeof rawTitle === "string" && rawTitle.trim()
      ? rawTitle.trim()
      : heading || label;
  const rawDate = frontmatter?.date;
  const date =
    typeof rawDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(rawDate)
      ? rawDate
      : null;
  return { title, date };
}

async function listProjectDocuments(
  project: RegisteredHandoffProject,
): Promise<HandoffDocumentMetadata[]> {
  const entries = await readdir(project.projectFolderPath, { withFileTypes: true });
  const documents: HandoffDocumentMetadata[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".md") continue;
    const label = path.basename(entry.name, path.extname(entry.name));
    if (!LABEL_PATTERN.test(label)) continue;
    const candidate = path.join(project.projectFolderPath, entry.name);
    const resolved = await realpath(candidate);
    if (!isInside(project.projectFolderPath, resolved)) continue;
    const [content, fileStat] = await Promise.all([
      readFile(resolved, "utf8"),
      stat(resolved),
    ]);
    const metadata = parseMetadata(content, label);
    documents.push({
      projectSlug: project.projectSlug,
      projectPath: project.projectPath,
      projectFolderPath: project.projectFolderPath,
      label,
      documentId: `${project.projectSlug}/${label}`,
      title: metadata.title,
      date: metadata.date,
      path: resolved.replaceAll("\\", "/"),
      modifiedAt: fileStat.mtime.toISOString(),
    });
  }

  return documents.sort(
    (left, right) =>
      (right.date ?? "").localeCompare(left.date ?? "", "en") ||
      right.modifiedAt.localeCompare(left.modifiedAt, "en") ||
      left.label.localeCompare(right.label, "en"),
  );
}

export async function listHandoffs(
  input: HandoffTarget & { all?: boolean } = {},
  options: { handoffRoot?: string } = {},
): Promise<HandoffListResult> {
  const handoffRoot = options.handoffRoot ?? DEFAULT_HANDOFF_ROOT;
  if (
    input.all === true &&
    (input.projectPath !== undefined || input.projectSlug !== undefined)
  ) {
    throw new HandoffStoreError(
      "Handoff list all cannot be combined with a project target",
      "invalid_target",
    );
  }
  if (input.projectPath !== undefined && input.projectSlug !== undefined) {
    validateProjectSlug(input.projectSlug);
  }

  const projects = input.all === true
    ? await registeredProjects(handoffRoot)
    : [
        await resolveTargetProject(
          {
            ...(input.projectPath === undefined
              ? input.projectSlug === undefined
                ? { projectPath: process.cwd() }
                : {}
              : { projectPath: input.projectPath }),
            ...(input.projectSlug === undefined
              ? {}
              : { projectSlug: input.projectSlug }),
          },
          handoffRoot,
        ),
      ];
  const listings = await Promise.all(
    projects.map(async (project) => ({
      ...project,
      documents: await listProjectDocuments(project),
    })),
  );
  return {
    scope: input.all === true ? "all" : "project",
    projects: listings,
    totalProjects: listings.length,
    totalDocuments: listings.reduce(
      (total, project) => total + project.documents.length,
      0,
    ),
  };
}

export async function getHandoff(
  input: HandoffTarget & { label: string },
  options: { handoffRoot?: string } = {},
): Promise<HandoffDocument> {
  validateLabel(input.label);
  const listing = await listHandoffs(
    {
      ...(input.projectPath === undefined ? {} : { projectPath: input.projectPath }),
      ...(input.projectSlug === undefined ? {} : { projectSlug: input.projectSlug }),
    },
    options,
  );
  const project = listing.projects[0]!;
  const metadata = project.documents.find(
    (document) => document.label === input.label,
  );
  if (metadata === undefined) {
    throw new HandoffStoreError(
      `Handoff document not found: ${input.label}`,
      "not_found",
    );
  }
  const resolved = await realpath(metadata.path);
  if (!isInside(project.projectFolderPath, resolved)) {
    throw new HandoffStoreError(
      "Handoff document resolves outside its registered project folder",
      "not_found",
    );
  }
  return {
    ...metadata,
    content: await readFile(resolved, "utf8"),
  };
}

export async function saveHandoff(
  input: HandoffSaveInput,
  options: { handoffRoot?: string } = {},
): Promise<HandoffWriteResult> {
  validateLabel(input.label);
  const document = normalizeDocument(input.content);
  const handoffRoot = options.handoffRoot ?? DEFAULT_HANDOFF_ROOT;
  const project = await resolveWritableTargetProject(input, handoffRoot);
  const destination = path.join(project.projectFolderPath, `${input.label}.md`);
  if (!isInside(project.projectFolderPath, destination)) {
    throw new HandoffStoreError(
      "Handoff document path escapes its registered project folder",
      "write_failed",
    );
  }
  await writeNewDocument(destination, document.content);
  const saved = await getHandoff(
    { projectSlug: project.projectSlug, label: input.label },
    options,
  );
  return { ...saved, operation: "created" };
}

export async function updateHandoff(
  input: HandoffUpdateInput,
  options: { handoffRoot?: string } = {},
): Promise<HandoffWriteResult> {
  validateLabel(input.label);
  const mode = input.mode ?? "replace";
  const target = await getHandoff(
    {
      label: input.label,
      ...(input.projectPath === undefined ? {} : { projectPath: input.projectPath }),
      ...(input.projectSlug === undefined ? {} : { projectSlug: input.projectSlug }),
    },
    options,
  );
  return withDocumentLock(target.path, async () => {
    const existing = await getHandoff(
      {
        label: input.label,
        ...(input.projectPath === undefined ? {} : { projectPath: input.projectPath }),
        ...(input.projectSlug === undefined ? {} : { projectSlug: input.projectSlug }),
      },
      options,
    );

    let content: string;
    if (mode === "append") {
      content = appendToDocument(existing, input.content);
    } else {
      const replacement = normalizeDocument(input.content);
      content =
        existing.date === null
          ? replacement.content
          : preserveDocumentDate(replacement.content, existing.date);
    }

    await replaceDocument(existing.path, content);
    const updated = await getHandoff(
      { projectSlug: existing.projectSlug, label: input.label },
      options,
    );
    return {
      ...updated,
      operation: mode === "append" ? "appended" : "replaced",
    };
  });
}

export function handoffVirtualPath(projectSlug: string, label: string): string {
  validateProjectSlug(projectSlug);
  validateLabel(label);
  return `@handoff/${projectSlug}/${label}.md`;
}

export function parseHandoffVirtualPath(
  value: string,
): { projectSlug: string; label: string } | null {
  const match = VIRTUAL_HANDOFF_PATTERN.exec(value);
  if (match === null) return null;
  const projectSlug = match[1]!;
  const label = match[2]!;
  if (!PROJECT_SLUG_PATTERN.test(projectSlug) || !LABEL_PATTERN.test(label)) {
    return null;
  }
  return { projectSlug, label };
}
