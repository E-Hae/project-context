import { createHash, randomBytes } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { z } from "zod/v4";

import type { ProjectContextConfig } from "./config.js";
import type { SourceKind } from "./source-policy.js";
import type { VectorStoreBackend } from "./vector-store.js";

export const INDEX_STATE_VERSION = 1;
export const CHUNKER_VERSION = 3;
export const DEFAULT_STATE_ROOT = path.join(
  homedir(),
  ".project-context",
  "state",
);

export interface ProjectIndexIdentity {
  projectSlug: string;
  collectionName: string;
  stateKey: string;
}

export interface ProjectIndexFileState {
  hash: string;
  source: SourceKind;
  chunkIds: string[];
}

export interface ProjectIndexState {
  version: 1;
  chunkerVersion: 3;
  projectRoot: string;
  projectSlug: string;
  collectionName: string;
  vectorStoreBackend?: VectorStoreBackend;
  embeddingModel: string;
  embeddingDimension: number;
  indexedAt: string;
  commit: string | null;
  files: Record<string, ProjectIndexFileState>;
}

const fileStateSchema = z.object({
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  source: z.enum(["code", "document"]),
  chunkIds: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(20_000),
}).strict();

const indexStateSchema = z.object({
  version: z.literal(INDEX_STATE_VERSION),
  chunkerVersion: z.literal(CHUNKER_VERSION),
  projectRoot: z.string().min(1).max(4_096),
  projectSlug: z.string().min(1).max(128),
  collectionName: z.string().min(1).max(255),
  vectorStoreBackend: z.enum(["local", "milvus"]).default("milvus"),
  embeddingModel: z.string().min(1).max(512),
  embeddingDimension: z.number().int().min(2).max(32_768),
  indexedAt: z.iso.datetime(),
  commit: z.string().max(128).nullable(),
  files: z.record(z.string().max(4_096), fileStateSchema),
}).strict();

export interface LoadedIndexState {
  path: string;
  exists: boolean;
  valid: boolean;
  errors: string[];
  value: ProjectIndexState | null;
}

function normalizedRoot(value: string): string {
  const normalized = path.normalize(value).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function safeSlug(value: string): string {
  const slug = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  return slug || "project";
}

function shortHash(value: string, length: number): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

export function deriveProjectIndexIdentity(
  projectRoot: string,
  config: ProjectContextConfig,
): ProjectIndexIdentity {
  const root = normalizedRoot(projectRoot);
  const projectSlug = safeSlug(
    config.sources.handoff.projectSlug ?? path.basename(projectRoot),
  );
  const rootHash = shortHash(root, 12);
  const collectionHash = shortHash(
    `${root}\0${config.services.ollama.embeddingModel}\0${config.services.vectorStore.backend}`,
    12,
  );
  return {
    projectSlug,
    collectionName: `pc_${projectSlug}_${collectionHash}_v1`,
    stateKey: `${projectSlug}_${rootHash}`,
  };
}

export function projectIndexStatePath(
  identity: ProjectIndexIdentity,
  stateRoot = DEFAULT_STATE_ROOT,
): string {
  return path.join(stateRoot, `${identity.stateKey}.json`);
}

export async function loadProjectIndexState(
  identity: ProjectIndexIdentity,
  stateRoot = DEFAULT_STATE_ROOT,
): Promise<LoadedIndexState> {
  const statePath = projectIndexStatePath(identity, stateRoot);
  try {
    const stateStat = await stat(statePath);
    if (!stateStat.isFile() || stateStat.size > 64 * 1024 * 1024) {
      return {
        path: statePath,
        exists: true,
        valid: false,
        errors: ["Index state is not a regular file or exceeds 64 MiB"],
        value: null,
      };
    }
    const parsed = indexStateSchema.safeParse(
      JSON.parse(await readFile(statePath, "utf8")),
    );
    if (!parsed.success) {
      return {
        path: statePath,
        exists: true,
        valid: false,
        errors: parsed.error.issues.map((issue) => issue.message),
        value: null,
      };
    }
    return {
      path: statePath,
      exists: true,
      valid: true,
      errors: [],
      value: parsed.data,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        path: statePath,
        exists: false,
        valid: true,
        errors: [],
        value: null,
      };
    }
    return {
      path: statePath,
      exists: true,
      valid: false,
      errors: [error instanceof Error ? error.message : String(error)],
      value: null,
    };
  }
}

export async function saveProjectIndexState(
  identity: ProjectIndexIdentity,
  state: ProjectIndexState,
  stateRoot = DEFAULT_STATE_ROOT,
): Promise<string> {
  const parsed = indexStateSchema.parse(state);
  const statePath = projectIndexStatePath(identity, stateRoot);
  await mkdir(stateRoot, { recursive: true });
  const temporaryPath = `${statePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(parsed, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, statePath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
  return statePath;
}

export async function removeProjectIndexState(
  identity: ProjectIndexIdentity,
  stateRoot = DEFAULT_STATE_ROOT,
): Promise<void> {
  await rm(projectIndexStatePath(identity, stateRoot), { force: true });
}

export async function acquireProjectIndexLock(
  identity: ProjectIndexIdentity,
  stateRoot = DEFAULT_STATE_ROOT,
): Promise<() => Promise<void>> {
  await mkdir(stateRoot, { recursive: true });
  const lockPath = path.join(stateRoot, `${identity.stateKey}.lock`);
  const clearStaleLock = async (): Promise<boolean> => {
    try {
      const lockStat = await stat(lockPath);
      const raw = JSON.parse(await readFile(lockPath, "utf8")) as {
        pid?: unknown;
      };
      if (typeof raw.pid === "number" && Number.isInteger(raw.pid) && raw.pid > 0) {
        try {
          process.kill(raw.pid, 0);
          return false;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EPERM") return false;
          await rm(lockPath, { force: true });
          return true;
        }
      }
      if (Date.now() - lockStat.mtimeMs > 24 * 60 * 60 * 1_000) {
        await rm(lockPath, { force: true });
        return true;
      }
      return false;
    } catch {
      return false;
    }
  };

  let handle: FileHandle | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      handle = await open(lockPath, "wx", 0o600);
      break;
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "EEXIST" ||
        attempt === 1 ||
        !(await clearStaleLock())
      ) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new Error(`Another index operation holds lock ${lockPath}`);
        }
        throw error;
      }
    }
  }
  if (handle === undefined) {
    throw new Error(`Could not acquire index lock ${lockPath}`);
  }
  try {
    await handle.writeFile(
      `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
      "utf8",
    );
  } catch (error) {
    await handle.close();
    await rm(lockPath, { force: true });
    throw error;
  }

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await handle.close();
    await rm(lockPath, { force: true });
  };
}

export function isCompatibleIndexState(
  state: ProjectIndexState,
  projectRoot: string,
  config: ProjectContextConfig,
  identity: ProjectIndexIdentity,
): boolean {
  return (
    normalizedRoot(state.projectRoot) === normalizedRoot(projectRoot) &&
    state.projectSlug === identity.projectSlug &&
    state.collectionName === identity.collectionName &&
    (state.vectorStoreBackend ?? "milvus") ===
      config.services.vectorStore.backend &&
    state.embeddingModel === config.services.ollama.embeddingModel &&
    state.chunkerVersion === CHUNKER_VERSION
  );
}
