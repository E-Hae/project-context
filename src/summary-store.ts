import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod/v4";

import { DEFAULT_STATE_ROOT, type ProjectIndexIdentity } from "./index-state.js";

export const SUMMARY_INDEX_VERSION = 1;
export const MAX_SUMMARY_PAYLOAD_BYTES = 12 * 1024 * 1024;
const MAX_SUMMARY_MANIFEST_BYTES = 512 * 1024;

export interface SummarySourceLocator {
  path: string;
  lineStart: number;
  lineEnd: number;
  fileHash: string;
}

export interface SummaryNodeLocator extends SummarySourceLocator {
  id: string;
}

export interface SummaryEdgeLocator {
  id: string;
  relation: string;
  fromId: string;
  toId: string;
  evidence: SummarySourceLocator;
}

export interface ProjectSummaryModule {
  id: string;
  parentId: string | null;
  kind: "project" | "code_root" | "directory";
  path: string | null;
  nodes: SummaryNodeLocator[];
  edges: SummaryEdgeLocator[];
  sources: SummarySourceLocator[];
}

export interface ProjectSummaryPayload {
  version: 1;
  projectRoot: string;
  projectSlug: string;
  collectionName: string;
  indexedAt: string;
  commit: string | null;
  graphFingerprint: string;
  modules: ProjectSummaryModule[];
  diagnostics: string[];
  truncated: boolean;
}

export interface ProjectSummaryManifest {
  version: 1;
  projectRoot: string;
  projectSlug: string;
  collectionName: string;
  indexedAt: string;
  commit: string | null;
  graphFingerprint: string;
  file: string;
  moduleCount: number;
  nodeCount: number;
  edgeCount: number;
  sourceCount: number;
  truncated: boolean;
  diagnostics: string[];
}

export interface LoadedProjectSummary {
  path: string;
  exists: boolean;
  valid: boolean;
  errors: string[];
  value: ProjectSummaryManifest | null;
}

export interface LoadedProjectSummaryPayload {
  path: string;
  exists: boolean;
  valid: boolean;
  errors: string[];
  value: ProjectSummaryPayload | null;
}

const sourceLocatorSchema = z.object({
  path: z.string().min(1).max(4_096),
  lineStart: z.number().int().min(1),
  lineEnd: z.number().int().min(1),
  fileHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const nodeLocatorSchema = sourceLocatorSchema.extend({
  id: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const edgeLocatorSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  relation: z.string().min(1).max(128),
  fromId: z.string().regex(/^[a-f0-9]{64}$/),
  toId: z.string().regex(/^[a-f0-9]{64}$/),
  evidence: sourceLocatorSchema,
}).strict();
const moduleSchema = z.object({
  id: z.string().min(1).max(4_096),
  parentId: z.string().min(1).max(4_096).nullable(),
  kind: z.enum(["project", "code_root", "directory"]),
  path: z.string().min(1).max(4_096).nullable(),
  nodes: z.array(nodeLocatorSchema).max(20_000),
  edges: z.array(edgeLocatorSchema).max(50_000),
  sources: z.array(sourceLocatorSchema).max(50_000),
}).strict();
const payloadSchema = z.object({
  version: z.literal(SUMMARY_INDEX_VERSION),
  projectRoot: z.string().min(1).max(4_096),
  projectSlug: z.string().min(1).max(128),
  collectionName: z.string().min(1).max(255),
  indexedAt: z.iso.datetime(),
  commit: z.string().max(128).nullable(),
  graphFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  modules: z.array(moduleSchema).min(1).max(2_048),
  diagnostics: z.array(z.string().max(1_024)).max(100),
  truncated: z.boolean(),
}).strict().superRefine((value, context) => {
  const nodeCount = value.modules.reduce((total, module) => total + module.nodes.length, 0);
  const edgeCount = value.modules.reduce((total, module) => total + module.edges.length, 0);
  const sourceCount = value.modules.reduce((total, module) => total + module.sources.length, 0);
  if (nodeCount > 20_000) context.addIssue({ code: "custom", message: "Summary has too many node locators" });
  if (edgeCount > 50_000) context.addIssue({ code: "custom", message: "Summary has too many edge locators" });
  if (sourceCount > 70_000) context.addIssue({ code: "custom", message: "Summary has too many source locators" });
});
const manifestSchema = z.object({
  version: z.literal(SUMMARY_INDEX_VERSION),
  projectRoot: z.string().min(1).max(4_096),
  projectSlug: z.string().min(1).max(128),
  collectionName: z.string().min(1).max(255),
  indexedAt: z.iso.datetime(),
  commit: z.string().max(128).nullable(),
  graphFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  file: z.string().regex(/^[a-z0-9_-]+\.summary\.[a-f0-9]{12}\.json$/),
  moduleCount: z.number().int().min(1).max(2_048),
  nodeCount: z.number().int().min(0).max(20_000),
  edgeCount: z.number().int().min(0).max(50_000),
  sourceCount: z.number().int().min(0).max(70_000),
  truncated: z.boolean(),
  diagnostics: z.array(z.string().max(1_024)).max(100),
}).strict();

function countLocators(modules: readonly ProjectSummaryModule[]): {
  nodeCount: number;
  edgeCount: number;
  sourceCount: number;
} {
  return modules.reduce((total, module) => ({
    nodeCount: total.nodeCount + module.nodes.length,
    edgeCount: total.edgeCount + module.edges.length,
    sourceCount: total.sourceCount + module.sources.length,
  }), { nodeCount: 0, edgeCount: 0, sourceCount: 0 });
}

export function projectSummaryManifestPath(
  identity: ProjectIndexIdentity,
  stateRoot = DEFAULT_STATE_ROOT,
): string {
  return path.join(stateRoot, `${identity.stateKey}.summary.json`);
}

function summaryPayloadPath(
  identity: ProjectIndexIdentity,
  file: string,
  stateRoot: string,
): string {
  if (!/^[a-z0-9_-]+\.summary\.[a-f0-9]{12}\.json$/u.test(file)) {
    throw new Error("Summary payload file name is invalid");
  }
  return path.join(stateRoot, file);
}

async function writeJsonAtomically(target: string, value: unknown): Promise<void> {
  const temporary = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function payloadMatchesManifest(
  payload: ProjectSummaryPayload,
  manifest: ProjectSummaryManifest,
): boolean {
  const counts = countLocators(payload.modules);
  return (
    payload.projectRoot === manifest.projectRoot &&
    payload.projectSlug === manifest.projectSlug &&
    payload.collectionName === manifest.collectionName &&
    payload.indexedAt === manifest.indexedAt &&
    payload.commit === manifest.commit &&
    payload.graphFingerprint === manifest.graphFingerprint &&
    payload.modules.length === manifest.moduleCount &&
    counts.nodeCount === manifest.nodeCount &&
    counts.edgeCount === manifest.edgeCount &&
    counts.sourceCount === manifest.sourceCount &&
    payload.truncated === manifest.truncated
  );
}

export async function saveProjectSummary(
  identity: ProjectIndexIdentity,
  input: Omit<ProjectSummaryPayload, "version">,
  stateRoot = DEFAULT_STATE_ROOT,
): Promise<string> {
  await mkdir(stateRoot, { recursive: true });
  const previous = await loadProjectSummary(identity, stateRoot);
  const payload = payloadSchema.parse({ version: SUMMARY_INDEX_VERSION, ...input }) as ProjectSummaryPayload;
  if (Buffer.byteLength(JSON.stringify(payload), "utf8") > MAX_SUMMARY_PAYLOAD_BYTES) {
    throw new Error("Hierarchy summary snapshot exceeds the 12 MiB limit");
  }
  const counts = countLocators(payload.modules);
  const file = `${identity.stateKey}.summary.${randomBytes(6).toString("hex")}.json`;
  const manifest = manifestSchema.parse({
    version: SUMMARY_INDEX_VERSION,
    projectRoot: payload.projectRoot,
    projectSlug: payload.projectSlug,
    collectionName: payload.collectionName,
    indexedAt: payload.indexedAt,
    commit: payload.commit,
    graphFingerprint: payload.graphFingerprint,
    file,
    moduleCount: payload.modules.length,
    ...counts,
    truncated: payload.truncated,
    diagnostics: payload.diagnostics,
  }) as ProjectSummaryManifest;
  const payloadPath = summaryPayloadPath(identity, file, stateRoot);
  try {
    await writeJsonAtomically(payloadPath, payload);
    await writeJsonAtomically(projectSummaryManifestPath(identity, stateRoot), manifest);
  } catch (error) {
    await rm(payloadPath, { force: true });
    throw error;
  }
  if (previous.valid && previous.value !== null && previous.value.file !== file) {
    await rm(summaryPayloadPath(identity, previous.value.file, stateRoot), { force: true }).catch(() => undefined);
  }
  return projectSummaryManifestPath(identity, stateRoot);
}

export async function loadProjectSummary(
  identity: ProjectIndexIdentity,
  stateRoot = DEFAULT_STATE_ROOT,
): Promise<LoadedProjectSummary> {
  const manifestPath = projectSummaryManifestPath(identity, stateRoot);
  try {
    const file = await stat(manifestPath);
    if (!file.isFile() || file.size > MAX_SUMMARY_MANIFEST_BYTES) {
      return { path: manifestPath, exists: true, valid: false, errors: ["Summary manifest is not a regular file or exceeds 512 KiB"], value: null };
    }
    const parsed = manifestSchema.safeParse(JSON.parse(await readFile(manifestPath, "utf8")));
    if (!parsed.success) {
      return { path: manifestPath, exists: true, valid: false, errors: parsed.error.issues.map((issue) => issue.message), value: null };
    }
    return { path: manifestPath, exists: true, valid: true, errors: [], value: parsed.data as ProjectSummaryManifest };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { path: manifestPath, exists: false, valid: true, errors: [], value: null };
    }
    return { path: manifestPath, exists: true, valid: false, errors: [error instanceof Error ? error.message : String(error)], value: null };
  }
}

export async function loadProjectSummaryPayload(
  identity: ProjectIndexIdentity,
  manifest: ProjectSummaryManifest,
  stateRoot = DEFAULT_STATE_ROOT,
): Promise<LoadedProjectSummaryPayload> {
  const payloadPath = summaryPayloadPath(identity, manifest.file, stateRoot);
  try {
    const file = await stat(payloadPath);
    if (!file.isFile() || file.size > MAX_SUMMARY_PAYLOAD_BYTES) {
      return { path: payloadPath, exists: true, valid: false, errors: ["Summary payload is not a regular file or exceeds 12 MiB"], value: null };
    }
    const parsed = payloadSchema.safeParse(JSON.parse(await readFile(payloadPath, "utf8")));
    if (!parsed.success) {
      return { path: payloadPath, exists: true, valid: false, errors: parsed.error.issues.map((issue) => issue.message), value: null };
    }
    if (!payloadMatchesManifest(parsed.data as ProjectSummaryPayload, manifest)) {
      return { path: payloadPath, exists: true, valid: false, errors: ["Summary payload does not match its manifest"], value: null };
    }
    return { path: payloadPath, exists: true, valid: true, errors: [], value: parsed.data as ProjectSummaryPayload };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { path: payloadPath, exists: false, valid: false, errors: ["Summary payload is missing"], value: null };
    }
    return { path: payloadPath, exists: true, valid: false, errors: [error instanceof Error ? error.message : String(error)], value: null };
  }
}
