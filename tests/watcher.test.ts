import assert from "node:assert/strict";
import test from "node:test";

import type { IndexSummary } from "../src/indexer.js";
import {
  watchProject,
  type WatchEvent,
} from "../src/watcher.js";

function summary(run: number): IndexSummary {
  return {
    projectRoot: "/project-root",
    projectSlug: "fixture",
    collectionName: "fixture_collection",
    statePath: "/state/fixture.json",
    commit: null,
    indexedAt: `2026-07-14T00:00:0${run}.000Z`,
    embeddingModel: "fixture-embedding",
    embeddingDimension: 2,
    filesSeen: 1,
    filesIndexed: run === 1 ? 1 : 0,
    filesUnchanged: run === 1 ? 0 : 1,
    filesDeleted: 0,
    filesSkipped: 0,
    fallbackDecodedFiles: 0,
    indexedFileSample: [],
    deletedFileSample: [],
    fallbackDecodedFileSample: [],
    skippedFiles: [],
    chunksUpserted: run === 1 ? 1 : 0,
    chunksDeleted: 0,
    rebuiltCollection: run === 1,
    timingsMs: { collect: 1, prepare: 1, index: 1, delete: 1, saveState: 1, total: 5 },
  };
}

class FakeWatcher {
  closed = false;

  constructor(
    private readonly onChange: () => void,
    private readonly onError: () => void,
  ) {}

  close(): void {
    this.closed = true;
  }

  emitChange(): void {
    this.onChange();
  }

  emitError(): void {
    this.onError();
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function createHarness() {
  const safetyWaits: Array<() => void> = [];
  const safetyIntervals: number[] = [];
  const timers = new Map<object, () => void>();
  const watchers: FakeWatcher[] = [];
  let createWatcher: (root: string, watcher: FakeWatcher) => void = () => {};

  return {
    watchers,
    setCreateWatcher(callback: (root: string, watcher: FakeWatcher) => void): void {
      createWatcher = callback;
    },
    dependencies: {
      resolveProjectRoot: async () => ({
        requestedPath: "/fixture/subdirectory",
        root: "/project-root",
        commit: null,
      }),
      createWatcher: (root: string, onChange: () => void, onError: () => void) => {
        const watcher = new FakeWatcher(onChange, onError);
        createWatcher(root, watcher);
        watchers.push(watcher);
        return watcher;
      },
      wait: (_milliseconds: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
        safetyIntervals.push(_milliseconds);
        safetyWaits.push(resolve);
        signal?.addEventListener("abort", () => resolve(), { once: true });
      }),
      setTimer: (callback: () => void) => {
        const timer = {};
        timers.set(timer, callback);
        return timer as ReturnType<typeof setTimeout>;
      },
      clearTimer: (timer: ReturnType<typeof setTimeout>) => {
        timers.delete(timer as object);
      },
      now: () => new Date("2026-07-14T00:00:00.000Z"),
    },
    triggerSafety(): void {
      safetyWaits.shift()?.();
    },
    safetyIntervals,
    triggerTimers(): void {
      const callbacks = [...timers.values()];
      timers.clear();
      callbacks.forEach((callback) => callback());
    },
    timerCount(): number {
      return timers.size;
    },
  };
}

test("watchProject indexes immediately and stays idle until its safety interval", async () => {
  const controller = new AbortController();
  const harness = createHarness();
  const order: string[] = [];
  let runs = 0;
  harness.setCreateWatcher((root) => order.push(`watch:${root}`));

  const service = watchProject("/fixture/subdirectory", {
    signal: controller.signal,
    dependencies: {
      ...harness.dependencies,
      indexProject: async () => {
        order.push("index");
        runs += 1;
        return summary(runs);
      },
    },
  });
  await tick();

  assert.deepEqual(order, ["watch:/project-root", "index"]);
  assert.equal(runs, 1);
  assert.deepEqual(harness.safetyIntervals, [300_000]);
  controller.abort();
  await service;
});

test("watchProject debounces and coalesces watcher events", async () => {
  const controller = new AbortController();
  const harness = createHarness();
  let runs = 0;
  const service = watchProject("/fixture", {
    signal: controller.signal,
    dependencies: { ...harness.dependencies, indexProject: async () => summary(++runs) },
  });
  await tick();

  harness.watchers[0]!.emitChange();
  harness.watchers[0]!.emitChange();
  harness.watchers[0]!.emitChange();
  assert.equal(harness.timerCount(), 1);
  harness.triggerTimers();
  await tick();

  assert.equal(runs, 2);
  controller.abort();
  await service;
});

test("watchProject continues event-driven indexing when an observer throws", async () => {
  const controller = new AbortController();
  const harness = createHarness();
  let runs = 0;
  const service = watchProject("/fixture", {
    signal: controller.signal,
    onEvent: () => {
      throw new Error("observer unavailable");
    },
    dependencies: { ...harness.dependencies, indexProject: async () => summary(++runs) },
  });
  await tick();

  harness.watchers[0]!.emitChange();
  harness.triggerTimers();
  await tick();

  assert.equal(runs, 2);
  controller.abort();
  await service;
});

test("watchProject continues event-driven indexing when an observer rejects", async () => {
  const controller = new AbortController();
  const harness = createHarness();
  const unhandledRejections: unknown[] = [];
  const onUnhandledRejection = (reason: unknown): void => {
    unhandledRejections.push(reason);
  };
  let runs = 0;
  process.on("unhandledRejection", onUnhandledRejection);
  try {
    const service = watchProject("/fixture", {
      signal: controller.signal,
      onEvent: async () => {
        throw new Error("observer unavailable");
      },
      dependencies: { ...harness.dependencies, indexProject: async () => summary(++runs) },
    });
    await tick();

    harness.watchers[0]!.emitChange();
    harness.triggerTimers();
    await tick();

    assert.equal(runs, 2);
    assert.deepEqual(unhandledRejections, []);
    controller.abort();
    await service;
  } finally {
    process.removeListener("unhandledRejection", onUnhandledRejection);
  }
});

test("watchProject queues one serialized follow-up for events during indexing", async () => {
  const controller = new AbortController();
  const harness = createHarness();
  const firstIndex = deferred();
  let runs = 0;
  let concurrent = 0;
  let highestConcurrent = 0;
  const service = watchProject("/fixture", {
    signal: controller.signal,
    dependencies: {
      ...harness.dependencies,
      indexProject: async () => {
        runs += 1;
        concurrent += 1;
        highestConcurrent = Math.max(highestConcurrent, concurrent);
        if (runs === 1) await firstIndex.promise;
        concurrent -= 1;
        return summary(runs);
      },
    },
  });
  await tick();

  harness.watchers[0]!.emitChange();
  harness.watchers[0]!.emitChange();
  firstIndex.resolve();
  await tick();

  assert.equal(runs, 2);
  assert.equal(highestConcurrent, 1);
  controller.abort();
  await service;
});

test("watchProject performs periodic safety scans", async () => {
  const controller = new AbortController();
  const harness = createHarness();
  let runs = 0;
  const service = watchProject("/fixture", {
    intervalMs: 250,
    signal: controller.signal,
    dependencies: { ...harness.dependencies, indexProject: async () => summary(++runs) },
  });
  await tick();
  harness.triggerSafety();
  await tick();

  assert.equal(runs, 2);
  controller.abort();
  await service;
});

test("watchProject falls back to safety scans and retries failed watchers", async () => {
  const controller = new AbortController();
  const harness = createHarness();
  let attempts = 0;
  let runs = 0;
  harness.setCreateWatcher(() => {
    attempts += 1;
    if (attempts === 1) throw new Error("watch unavailable");
  });
  const service = watchProject("/fixture", {
    signal: controller.signal,
    dependencies: { ...harness.dependencies, indexProject: async () => summary(++runs) },
  });
  await tick();
  assert.equal(runs, 1);
  assert.equal(harness.watchers.length, 0);

  harness.triggerSafety();
  await tick();
  assert.equal(harness.watchers.length, 1);
  harness.watchers[0]!.emitError();
  assert.equal(harness.watchers[0]!.closed, true);
  harness.triggerSafety();
  await tick();

  assert.equal(harness.watchers.length, 2);
  assert.equal(runs, 3);
  controller.abort();
  await service;
});

test("watchProject reports index failures and cleans up on abort", async () => {
  const controller = new AbortController();
  const harness = createHarness();
  const events: WatchEvent[] = [];
  let runs = 0;
  const service = watchProject("/fixture", {
    signal: controller.signal,
    onEvent: (event) => events.push(event),
    dependencies: {
      ...harness.dependencies,
      indexProject: async () => {
        runs += 1;
        if (runs === 1) throw new Error("Milvus unavailable");
        return summary(runs);
      },
    },
  });
  await tick();

  harness.watchers[0]!.emitChange();
  assert.equal(harness.timerCount(), 1);
  controller.abort();
  assert.equal(harness.timerCount(), 0);
  harness.triggerTimers();
  await service;

  assert.equal(harness.watchers[0]!.closed, true);
  assert.equal(runs, 1);
  assert.equal(events[0]?.ok, false);
  assert.match(events[0]?.ok === false ? events[0].error : "", /Milvus/);
});

test("watchProject rejects an unsafe safety interval", async () => {
  await assert.rejects(
    watchProject("/fixture", { intervalMs: 0 }),
    /Watch interval/,
  );
});
