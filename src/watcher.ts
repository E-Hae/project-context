import { watch } from "node:fs";

import {
  indexProject,
  type IndexSummary,
} from "./indexer.js";
import { resolveProjectRoot } from "./project-path.js";

export type WatchEvent =
  | {
      run: number;
      ok: true;
      startedAt: string;
      finishedAt: string;
      summary: IndexSummary;
    }
  | {
      run: number;
      ok: false;
      startedAt: string;
      finishedAt: string;
      error: string;
    };

interface FileWatcher {
  close(): void;
}

interface WatchDependencies {
  indexProject: typeof indexProject;
  resolveProjectRoot: typeof resolveProjectRoot;
  createWatcher: (
    projectRoot: string,
    onChange: () => void,
    onError: () => void,
  ) => FileWatcher;
  wait: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  setTimer: (callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout>;
  clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
  now: () => Date;
}

export interface WatchProjectOptions {
  intervalMs?: number;
  signal?: AbortSignal;
  stateRoot?: string;
  handoffRoot?: string;
  timeoutMs?: number;
  onEvent?: (event: WatchEvent) => unknown;
  dependencies?: Partial<WatchDependencies>;
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

const DEBOUNCE_MS = 500;

function createWatcher(
  projectRoot: string,
  onChange: () => void,
  onError: () => void,
): FileWatcher {
  const watcher = watch(projectRoot, { recursive: true }, onChange);
  watcher.on("error", onError);
  return watcher;
}

export async function watchProject(
  projectPath: string,
  options: WatchProjectOptions = {},
): Promise<void> {
  const intervalMs = options.intervalMs ?? 300_000;
  if (
    !Number.isInteger(intervalMs) ||
    intervalMs < 250 ||
    intervalMs > 3_600_000
  ) {
    throw new Error("Watch interval must be an integer from 250 to 3600000ms");
  }
  const dependencies: WatchDependencies = {
    indexProject,
    resolveProjectRoot,
    createWatcher,
    wait,
    setTimer: setTimeout,
    clearTimer: clearTimeout,
    now: () => new Date(),
    ...options.dependencies,
  };
  let run = 0;

  let watcher: FileWatcher | undefined;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let indexing = false;
  let queued = false;
  let running: Promise<void> | undefined;

  const reportEvent = (event: WatchEvent): void => {
    try {
      void Promise.resolve(options.onEvent?.(event)).catch(() => {
        // Observer failures must not affect indexing.
      });
    } catch {
      // Observer failures must not affect indexing.
    }
  };

  const closeWatcher = (): void => {
    const activeWatcher = watcher;
    watcher = undefined;
    try {
      activeWatcher?.close();
    } catch {
      // A watcher that already failed may reject close; periodic scans remain safe.
    }
  };

  const indexOnce = async (): Promise<void> => {
    run += 1;
    const startedAt = dependencies.now().toISOString();
    try {
      const summary = await dependencies.indexProject(projectPath, {
        ...(options.stateRoot === undefined ? {} : { stateRoot: options.stateRoot }),
        ...(options.handoffRoot === undefined
          ? {}
          : { handoffRoot: options.handoffRoot }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      });
      reportEvent({
        run,
        ok: true,
        startedAt,
        finishedAt: dependencies.now().toISOString(),
        summary,
      });
    } catch (error) {
      reportEvent({
        run,
        ok: false,
        startedAt,
        finishedAt: dependencies.now().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const runQueued = (): Promise<void> => {
    if (indexing) return running!;
    indexing = true;
    running = (async () => {
      while (queued && !options.signal?.aborted) {
        queued = false;
        await indexOnce();
      }
    })().finally(() => {
      indexing = false;
      running = undefined;
    });
    return running;
  };

  const requestImmediateRun = (): Promise<void> => {
    if (options.signal?.aborted) return Promise.resolve();
    if (debounceTimer !== undefined) {
      dependencies.clearTimer(debounceTimer);
      debounceTimer = undefined;
    }
    queued = true;
    return runQueued();
  };

  const requestEventRun = (): void => {
    if (options.signal?.aborted) return;
    queued = true;
    if (indexing || debounceTimer !== undefined) return;
    debounceTimer = dependencies.setTimer(() => {
      debounceTimer = undefined;
      void runQueued();
    }, DEBOUNCE_MS);
  };

  const installWatcher = async (): Promise<void> => {
    if (watcher !== undefined || options.signal?.aborted) return;
    try {
      const project = await dependencies.resolveProjectRoot(projectPath);
      if (options.signal?.aborted) return;
      let createdWatcher: FileWatcher | undefined;
      createdWatcher = dependencies.createWatcher(
        project.root,
        () => {
          if (watcher === createdWatcher) requestEventRun();
        },
        () => {
          if (watcher === createdWatcher) closeWatcher();
        },
      );
      watcher = createdWatcher;
    } catch {
      closeWatcher();
    }
  };

  const stop = (): void => {
    if (debounceTimer !== undefined) {
      dependencies.clearTimer(debounceTimer);
      debounceTimer = undefined;
    }
    closeWatcher();
  };

  options.signal?.addEventListener("abort", stop, { once: true });
  try {
    await installWatcher();
    await requestImmediateRun();
    while (!options.signal?.aborted) {
      await dependencies.wait(intervalMs, options.signal);
      if (options.signal?.aborted) break;
      await installWatcher();
      await requestImmediateRun();
    }
  } finally {
    options.signal?.removeEventListener("abort", stop);
    stop();
  }
}
