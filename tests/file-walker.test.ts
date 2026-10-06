import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  FileWalkTimeoutError,
  walkProjectFiles,
} from "../src/file-walker.js";
import type { SourceTarget } from "../src/source-policy.js";
import { withGitConfigHome } from "./git-config-fixture.js";

async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(root, ...relativePath.split("/"));
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, contents, "utf8");
  }
}

function target(root: string, relativePath: string, isDirectory = true): SourceTarget {
  return {
    source: "code",
    absolutePath: path.join(root, ...relativePath.split("/")),
    relativePath,
    isDirectory,
  };
}

async function walk(
  root: string,
  targets: SourceTarget[],
  excludes: string[] = [],
): Promise<string[]> {
  const files = await walkProjectFiles(root, targets, excludes, Date.now() + 30_000);
  return files.map((file) => file.relativePath).sort();
}

/** Walks with no global Git excludes file. */
function walkIsolated(
  root: string,
  targets: SourceTarget[],
  excludes: string[] = [],
): Promise<string[]> {
  return withGitConfigHome(path.join(root, "no-home"), () => walk(root, targets, excludes));
}

async function createRoot(): Promise<string> {
  return realpath(await mkdtemp(path.join(tmpdir(), "project-context-walk-")));
}

test("walkProjectFiles applies ignore files to directories and globs to files", async () => {
  const root = await createRoot();
  try {
    await mkdir(path.join(root, ".git"));
    await writeFiles(root, {
      ".gitignore": "gen/\n/src/anchored/\n*.log.json\nbuild*\n!buildkeep/\n",
      "src/.ignore": "local/\n",
      "src/sub/.gitignore": "!gen/\n",
      "LICENSE": "license\n",
      "lib/l.ts": "",
      "src/a.ts": "",
      "src/gen/x.ts": "",
      "src/sub/gen/y.ts": "",
      "src/anchored/z.ts": "",
      "src/other/anchored/w.ts": "",
      "src/x.log.json": "",
      "src/build1/b.ts": "",
      "src/buildkeep/c.ts": "",
      "src/local/l.ts": "",
      "src/.hidden/h.ts": "",
      "src/.eslintrc.json": "",
      "src/image.png": "",
      "src/Upper.CS": "",
      "src/node_modules/m.ts": "",
      "src/deep/LocalData.json": "",
      "src/skip/s.ts": "",
    });

    // "lib" comes first so the root rule anchored at src/anchored must still
    // apply when another target was walked before src.
    const files = await walkIsolated(
      root,
      [target(root, "lib"), target(root, "src"), target(root, "LICENSE", false)],
      ["**/node_modules/**", "LocalData.json", "src/skip/**"],
    );
    assert.deepEqual(files, [
      "LICENSE",
      "lib/l.ts",
      "src/.eslintrc.json",
      "src/a.ts",
      "src/buildkeep/c.ts",
      "src/other/anchored/w.ts",
      "src/sub/gen/y.ts",
      "src/x.log.json",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("walkProjectFiles applies Git rules only inside a repository", async () => {
  const root = await createRoot();
  try {
    await writeFiles(root, {
      ".gitignore": "gen/\n",
      ".ignore": "local/\n",
      "src/gen/x.ts": "",
      "src/local/l.ts": "",
      "src/excluded/e.ts": "",
    });
    assert.deepEqual(await walkIsolated(root, [target(root, "src")]), [
      "src/excluded/e.ts",
      "src/gen/x.ts",
    ]);

    await writeFiles(root, { ".git/info/exclude": "excluded/\n" });
    assert.deepEqual(await walkIsolated(root, [target(root, "src")]), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("walkProjectFiles applies the global Git excludes file", async () => {
  const root = await createRoot();
  try {
    const home = path.join(root, "home dir");
    const homeExcludes = path.join(root, "home dir", "global ignore").replaceAll("\\", "/");
    const xdgExcludes = path.join(root, "xdg-ignore").replaceAll("\\", "/");
    await mkdir(path.join(root, "project", ".git"), { recursive: true });
    await writeFiles(root, {
      "home dir/.gitconfig": `[core]\n\texcludesFile = "${homeExcludes}" ; comment\n`,
      "home dir/global ignore": "homedir/\n",
      "config/git/config": `[core]\n\texcludesFile = ${xdgExcludes}\n`,
      "xdg-ignore": "xdgdir/\n",
      "project/src/homedir/h.ts": "",
      "project/src/xdgdir/x.ts": "",
      "project/src/kept.ts": "",
    });
    const project = path.join(root, "project");
    // ~/.gitconfig wins over the XDG config, and a quoted path may hold spaces.
    const files = await withGitConfigHome(
      home,
      () => walk(project, [target(project, "src")]),
      path.join(root, "config"),
    );
    assert.deepEqual(files, ["src/kept.ts", "src/xdgdir/x.ts"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("walkProjectFiles rejects once the deadline has passed", async () => {
  const root = await createRoot();
  try {
    await writeFiles(root, { "src/a.ts": "" });
    await assert.rejects(
      walkProjectFiles(root, [target(root, "src")], [], Date.now() - 1),
      FileWalkTimeoutError,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
