import { execFile } from "node:child_process";
import { access, readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";

import {
  loadProjectConfig,
  type LoadedProjectConfig,
  type ProjectContextConfig,
} from "./config.js";
import {
  DEFAULT_STATE_ROOT,
  deriveProjectIndexIdentity,
  isCompatibleIndexState,
  loadProjectIndexState,
} from "./index-state.js";
import { getRoslynWorkerPath } from "./graph-client.js";
import { MilvusRestClient } from "./milvus-rest-client.js";

export type CheckState =
  | "ready"
  | "missing"
  | "unreachable"
  | "invalid"
  | "not_built";

export interface ComponentStatus {
  state: CheckState;
  detail: string;
  version?: string;
  latencyMs?: number;
}

export interface ProjectStatus {
  status: "ready" | "degraded" | "unavailable";
  checkedAt: string;
  project: {
    requestedPath: string;
    root: string | null;
    exists: boolean;
    gitCommit: string | null;
  };
  config: {
    path: string | null;
    exists: boolean;
    valid: boolean;
    errors: string[];
  };
  sources: ProjectContextConfig["sources"] | null;
  exclude: string[];
  components: {
    git: ComponentStatus;
    ripgrep: ComponentStatus;
    ollama: ComponentStatus;
    milvus: ComponentStatus;
    roslyn: ComponentStatus;
    handoff: ComponentStatus;
  };
  index: {
    state: "not_initialized" | "ready" | "stale" | "invalid";
    indexedAt: string | null;
    commit: string | null;
    stale: boolean | null;
    collectionName: string | null;
    errors: string[];
  };
  missing: string[];
}

interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

export interface StatusDependencies {
  runCommand: (
    command: string,
    args: string[],
    timeoutMs: number,
  ) => Promise<CommandResult>;
  fetch: typeof globalThis.fetch;
  probeTcp: (address: string, timeoutMs: number) => Promise<boolean>;
  loadConfig: (projectRoot: string) => Promise<LoadedProjectConfig>;
  handoffRoot: string;
  packageRoot: string;
  stateRoot: string;
  now: () => Date;
}

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PACKAGE_ROOT = path.resolve(moduleDirectory, "..", "..");

function defaultRunCommand(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        timeout: timeoutMs,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        resolve({
          ok: error === null,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          ...(error === null ? {} : { error: error.message }),
        });
      },
    );
  });
}

function parseTcpAddress(address: string): { host: string; port: number } | null {
  const separator = address.lastIndexOf(":");
  if (separator <= 0 || separator === address.length - 1) {
    return null;
  }

  const host = address.slice(0, separator).replace(/^\[|\]$/g, "");
  const port = Number(address.slice(separator + 1));
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }

  return { host, port };
}

function defaultProbeTcp(address: string, timeoutMs: number): Promise<boolean> {
  const target = parseTcpAddress(address);
  if (target === null) {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    const socket = net.createConnection(target);
    let settled = false;

    const finish = (result: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}

const DEFAULT_DEPENDENCIES: StatusDependencies = {
  runCommand: defaultRunCommand,
  fetch: globalThis.fetch,
  probeTcp: defaultProbeTcp,
  loadConfig: loadProjectConfig,
  handoffRoot: path.join(homedir(), ".agents", "handoff"),
  packageRoot: DEFAULT_PACKAGE_ROOT,
  stateRoot: DEFAULT_STATE_ROOT,
  now: () => new Date(),
};

function mergeDependencies(
  overrides: Partial<StatusDependencies>,
): StatusDependencies {
  return { ...DEFAULT_DEPENDENCIES, ...overrides };
}

function firstLine(value: string): string {
  return value.split(/\r?\n/, 1)[0]?.trim() ?? "";
}

async function checkCommand(
  deps: StatusDependencies,
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<ComponentStatus> {
  const result = await deps.runCommand(command, args, timeoutMs);
  if (!result.ok) {
    return {
      state: "missing",
      detail: result.error ?? result.stderr ?? `${command} is unavailable`,
    };
  }

  const version = firstLine(result.stdout);
  return {
    state: "ready",
    detail: version || `${command} is available`,
    ...(version ? { version } : {}),
  };
}

interface OllamaTagsResponse {
  models?: Array<{ name?: string; model?: string }>;
}

async function checkOllama(
  deps: StatusDependencies,
  config: ProjectContextConfig,
  timeoutMs: number,
): Promise<ComponentStatus> {
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const baseUrl = config.services.ollama.url.endsWith("/")
      ? config.services.ollama.url
      : `${config.services.ollama.url}/`;
    const url = new URL("api/tags", baseUrl);
    const response = await deps.fetch(url, { signal: controller.signal });
    if (!response.ok) {
      return {
        state: "unreachable",
        detail: `Ollama returned HTTP ${response.status}`,
        latencyMs: Date.now() - started,
      };
    }

    const body = (await response.json()) as OllamaTagsResponse;
    const modelNames = new Set(
      (body.models ?? []).flatMap((model) =>
        [model.name, model.model].filter(
          (name): name is string => typeof name === "string",
        ),
      ),
    );
    const model = config.services.ollama.embeddingModel;

    if (!modelNames.has(model)) {
      return {
        state: "missing",
        detail: `Ollama is reachable, but model ${model} is not installed`,
        latencyMs: Date.now() - started,
      };
    }

    return {
      state: "ready",
      detail: `Ollama model ${model} is available`,
      latencyMs: Date.now() - started,
    };
  } catch (error) {
    return {
      state: "unreachable",
      detail: error instanceof Error ? error.message : String(error),
      latencyMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function checkMilvus(
  deps: StatusDependencies,
  config: ProjectContextConfig,
  timeoutMs: number,
): Promise<ComponentStatus> {
  const address = config.services.milvus.address;
  const started = Date.now();
  let reachable: boolean;
  try {
    reachable = await deps.probeTcp(address, timeoutMs);
  } catch (error) {
    return {
      state: "unreachable",
      detail: error instanceof Error ? error.message : String(error),
      latencyMs: Date.now() - started,
    };
  }

  return {
    state: reachable ? "ready" : "unreachable",
    detail: reachable
      ? `Milvus is accepting TCP connections at ${address}`
      : `Milvus is not reachable at ${address}`,
    latencyMs: Date.now() - started,
  };
}

async function checkRoslyn(
  deps: StatusDependencies,
  timeoutMs: number,
): Promise<ComponentStatus> {
  const workerPath = getRoslynWorkerPath(deps.packageRoot);

  try {
    await access(workerPath);
  } catch {
    return {
      state: "not_built",
      detail: "Roslyn worker has not been built yet",
    };
  }

  return checkCommand(
    deps,
    "dotnet",
    [workerPath, "--version"],
    Math.max(timeoutMs, 5_000),
  );
}

function normalizePathForComparison(value: string): string {
  return path.normalize(value).replace(/[\\/]+$/, "").toLocaleLowerCase("en-US");
}

async function checkHandoff(
  deps: StatusDependencies,
  projectRoot: string,
  config: ProjectContextConfig,
): Promise<ComponentStatus> {
  if (!config.sources.handoff.enabled) {
    return {
      state: "missing",
      detail: "Handoff indexing is disabled in project configuration",
    };
  }

  try {
    const entries = await readdir(deps.handoffRoot, { withFileTypes: true });
    const expectedRoot = normalizePathForComparison(projectRoot);

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (
        config.sources.handoff.projectSlug &&
        entry.name.toLocaleLowerCase("en-US") !==
          config.sources.handoff.projectSlug.toLocaleLowerCase("en-US")
      ) {
        continue;
      }

      const markerPath = path.join(deps.handoffRoot, entry.name, ".project-path");
      try {
        const marker = (await readFile(markerPath, "utf8")).trim();
        if (normalizePathForComparison(marker) === expectedRoot) {
          return {
            state: "ready",
            detail: `Handoff project ${entry.name} matches the project root`,
          };
        }
      } catch {
        // Folders without a readable marker are not registered handoff projects.
      }
    }

    return {
      state: "missing",
      detail: "No handoff project marker matches the project root",
    };
  } catch (error) {
    return {
      state: "missing",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function unavailableStatus(requestedPath: string, checkedAt: string): ProjectStatus {
  const unavailable: ComponentStatus = {
    state: "missing",
    detail: "Project path is unavailable; component check was skipped",
  };

  return {
    status: "unavailable",
    checkedAt,
    project: {
      requestedPath,
      root: null,
      exists: false,
      gitCommit: null,
    },
    config: {
      path: null,
      exists: false,
      valid: false,
      errors: ["Project path does not exist or is not a directory"],
    },
    sources: null,
    exclude: [],
    components: {
      git: unavailable,
      ripgrep: unavailable,
      ollama: unavailable,
      milvus: unavailable,
      roslyn: unavailable,
      handoff: unavailable,
    },
    index: {
      state: "not_initialized",
      indexedAt: null,
      commit: null,
      stale: null,
      collectionName: null,
      errors: [],
    },
    missing: ["project"],
  };
}

export async function collectProjectStatus(
  projectPath: string,
  options: {
    timeoutMs?: number;
    dependencies?: Partial<StatusDependencies>;
  } = {},
): Promise<ProjectStatus> {
  const deps = mergeDependencies(options.dependencies ?? {});
  const timeoutMs = options.timeoutMs ?? 2_000;
  const requestedPath = path.resolve(projectPath);
  const checkedAt = deps.now().toISOString();

  try {
    const projectStat = await stat(requestedPath);
    if (!projectStat.isDirectory()) {
      return unavailableStatus(requestedPath, checkedAt);
    }
  } catch {
    return unavailableStatus(requestedPath, checkedAt);
  }

  let projectRoot: string;
  try {
    projectRoot = await realpath(requestedPath);
  } catch {
    return unavailableStatus(requestedPath, checkedAt);
  }

  const gitRoot = await deps.runCommand(
    "git",
    [
      "-c",
      `safe.directory=${projectRoot}`,
      "-C",
      projectRoot,
      "rev-parse",
      "--show-toplevel",
    ],
    timeoutMs,
  );
  if (gitRoot.ok && gitRoot.stdout) {
    projectRoot = gitRoot.stdout.trim();
  }

  const configPromise = deps.loadConfig(projectRoot);
  const commitPromise = gitRoot.ok
    ? deps.runCommand(
        "git",
        [
          "-c",
          `safe.directory=${projectRoot}`,
          "-C",
          projectRoot,
          "rev-parse",
          "HEAD",
        ],
        timeoutMs,
      )
    : Promise.resolve({
        ok: false,
        stdout: "",
        stderr: gitRoot.stderr,
        ...(gitRoot.error ? { error: gitRoot.error } : {}),
      });
  const [config, commitResult] = await Promise.all([
    configPromise,
    commitPromise,
  ]);

  const git: ComponentStatus = commitResult.ok && commitResult.stdout
    ? {
        state: "ready",
        detail: `Git commit ${commitResult.stdout}`,
      }
    : {
        state: "missing",
        detail:
          commitResult.error ||
          commitResult.stderr ||
          "Git repository or HEAD commit is unavailable",
      };

  const [ripgrep, ollama, milvus, roslyn, handoff] = await Promise.all([
    checkCommand(deps, "rg", ["--version"], timeoutMs),
    checkOllama(deps, config.value, timeoutMs),
    checkMilvus(deps, config.value, timeoutMs),
    checkRoslyn(deps, timeoutMs),
    checkHandoff(deps, projectRoot, config.value),
  ]);

  const identity = deriveProjectIndexIdentity(projectRoot, config.value);
  const loadedIndex = await loadProjectIndexState(identity, deps.stateRoot);
  const currentCommit =
    commitResult.ok && commitResult.stdout ? commitResult.stdout : null;
  let index: ProjectStatus["index"] = !loadedIndex.exists
    ? {
        state: "not_initialized" as const,
        indexedAt: null,
        commit: null,
        stale: null,
        collectionName: identity.collectionName,
        errors: [],
      }
    : !loadedIndex.valid || loadedIndex.value === null
      ? {
          state: "invalid" as const,
          indexedAt: null,
          commit: null,
          stale: true,
          collectionName: identity.collectionName,
          errors: loadedIndex.errors,
        }
      : (() => {
          const stale =
            !isCompatibleIndexState(
              loadedIndex.value,
              projectRoot,
              config.value,
              identity,
            ) || loadedIndex.value.commit !== currentCommit;
          return {
            state: stale ? ("stale" as const) : ("ready" as const),
            indexedAt: loadedIndex.value.indexedAt,
            commit: loadedIndex.value.commit,
            stale,
            collectionName: loadedIndex.value.collectionName,
            errors: [],
          };
        })();
  if (index.state === "ready" && milvus.state === "ready") {
    try {
      const vectorStore = new MilvusRestClient(
        config.value.services.milvus,
        deps.fetch,
        timeoutMs,
      );
      if (!(await vectorStore.hasCollection(identity.collectionName))) {
        index = {
          ...index,
          state: "invalid",
          stale: true,
          errors: ["Milvus index collection is missing"],
        };
      } else {
        const load = await vectorStore.getCollectionLoadState(
          identity.collectionName,
        );
        if (load.state !== "LoadStateLoaded") {
          index = {
            ...index,
            state: "invalid",
            stale: true,
            errors: [
              `Milvus index collection is not loaded (${load.state}${
                load.progress === null ? "" : `, ${load.progress}%`
              })`,
            ],
          };
        }
      }
    } catch (error) {
      index = {
        ...index,
        state: "invalid",
        stale: true,
        errors: [error instanceof Error ? error.message : String(error)],
      };
    }
  }

  const missing: string[] = [];
  if (!config.exists) missing.push("config");
  if (!config.valid) missing.push("config:invalid");
  if (git.state !== "ready") missing.push("git");
  if (ripgrep.state !== "ready") missing.push("ripgrep");
  if (ollama.state !== "ready") missing.push("ollama");
  if (milvus.state !== "ready") missing.push("milvus");
  if (roslyn.state !== "ready") missing.push("roslyn");
  if (handoff.state !== "ready") missing.push("handoff");
  if (index.state === "not_initialized") missing.push("index:not_initialized");
  if (index.state === "stale") missing.push("index:stale");
  if (index.state === "invalid") missing.push("index:invalid");

  const criticalMissing = !config.valid || ripgrep.state !== "ready";
  const status = criticalMissing
    ? "unavailable"
    : missing.length === 0
      ? "ready"
      : "degraded";

  return {
    status,
    checkedAt,
    project: {
      requestedPath,
      root: projectRoot,
      exists: true,
      gitCommit: currentCommit,
    },
    config: {
      path: config.path,
      exists: config.exists,
      valid: config.valid,
      errors: config.errors,
    },
    sources: config.value.sources,
    exclude: config.value.exclude,
    components: {
      git,
      ripgrep,
      ollama,
      milvus,
      roslyn,
      handoff,
    },
    index,
    missing,
  };
}
