import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  expandHomeMarker,
  foldHomeMarker,
  parseMainWorktreeRoot,
  resolveIndexRoot,
} from "../src/project-path.js";
import { createLinkedWorktree, gitAvailable } from "./git-worktree-fixture.js";
import { withHome } from "./home-fixture.js";

const MAIN_ROOT = "/repo/main";
const LINKED_ROOT = "/repo/main/.worktrees/feature";
const PORCELAIN = [
  `worktree ${MAIN_ROOT}`,
  "HEAD 0123456789abcdef0123456789abcdef01234567",
  "branch refs/heads/main",
  "",
  `worktree ${LINKED_ROOT}`,
  "HEAD 0123456789abcdef0123456789abcdef01234567",
  "branch refs/heads/feature",
].join("\n");

test("mainWorktreeRoot resolves the main worktree only for a linked worktree", () => {
  assert.equal(parseMainWorktreeRoot(PORCELAIN, LINKED_ROOT), MAIN_ROOT);
  assert.equal(parseMainWorktreeRoot(PORCELAIN, `${LINKED_ROOT}/`), MAIN_ROOT);
  assert.equal(
    parseMainWorktreeRoot(PORCELAIN.replaceAll("\n", "\r\n"), LINKED_ROOT),
    MAIN_ROOT,
  );
  assert.equal(parseMainWorktreeRoot(PORCELAIN, MAIN_ROOT), null);
  assert.equal(parseMainWorktreeRoot("", LINKED_ROOT), null);
  assert.equal(parseMainWorktreeRoot("detached", LINKED_ROOT), null);
});

test("mainWorktreeRoot reports no main worktree for a bare repository", () => {
  const porcelain = [
    "worktree /repo/bare.git",
    "bare",
    "",
    `worktree ${LINKED_ROOT}`,
    "branch refs/heads/feature",
  ].join("\n");

  assert.equal(parseMainWorktreeRoot(porcelain, LINKED_ROOT), null);
});

test("home markers expand ~/ against the home directory and fold paths under it", async () => {
  const home = path.join(tmpdir(), "project-context-home");
  await withHome(home, async () => {
    assert.equal(expandHomeMarker("~"), home);
    assert.equal(expandHomeMarker("~/Projects/Hub"), path.join(home, "Projects", "Hub"));
    assert.equal(expandHomeMarker("/srv/project"), "/srv/project");
    assert.equal(expandHomeMarker("~other/project"), "~other/project");

    assert.equal(foldHomeMarker(home), "~");
    assert.equal(foldHomeMarker(`${home}${path.sep}`), "~");
    assert.equal(foldHomeMarker(path.join(home, "Projects", "Hub")), "~/Projects/Hub");
    assert.equal(foldHomeMarker(`${home}-sibling`), `${home}-sibling`);
    const outside = path.join(tmpdir(), "elsewhere");
    assert.equal(foldHomeMarker(outside), outside);
    if (process.platform === "win32") {
      assert.equal(expandHomeMarker("~\\Projects\\Hub"), path.join(home, "Projects", "Hub"));
      assert.equal(foldHomeMarker(path.join(home.toUpperCase(), "Hub")), "~/Hub");
    }
  });
});

test("resolveIndexRoot redirects a linked worktree to the main worktree", async (t) => {
  if (!(await gitAvailable())) return t.skip("git is unavailable");
  const root = await mkdtemp(path.join(tmpdir(), "project-context-index-root-"));
  try {
    const { mainRoot, worktreeRoot } = await createLinkedWorktree(root, {
      "src/feature.ts": "export const feature = 1;\n",
    });

    assert.equal(await resolveIndexRoot(worktreeRoot, true), mainRoot);
    assert.equal(await resolveIndexRoot(worktreeRoot, false), worktreeRoot);
    assert.equal(await resolveIndexRoot(mainRoot, true), mainRoot);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
});
