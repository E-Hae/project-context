import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  HandoffStoreError,
  getHandoff,
  handoffVirtualPath,
  listHandoffs,
  parseHandoffVirtualPath,
  saveHandoff,
  updateHandoff,
} from "../src/handoff-store.js";

test("handoff store resolves markers case-insensitively and reads Markdown verbatim", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-context-handoff-"));
  const projectRoot = path.join(root, "GameProject");
  const handoffRoot = path.join(root, "handoff");
  const projectFolder = path.join(handoffRoot, "game-project");
  const emptyFolder = path.join(handoffRoot, "empty-project");
  try {
    await mkdir(projectRoot, { recursive: true });
    await mkdir(projectFolder, { recursive: true });
    await mkdir(emptyFolder, { recursive: true });
    await writeFile(
      path.join(projectFolder, ".project-path"),
      `${projectRoot.replaceAll("\\", "/").toUpperCase()}\n`,
      "utf8",
    );
    await writeFile(
      path.join(emptyFolder, ".project-path"),
      `${path.join(root, "EmptyProject")}\n`,
      "utf8",
    );
    const older = "---\ntitle: Older plan\ndate: 2026-07-01\n---\n\n# Older\nBody\n";
    const newer = "---\ntitle: New analysis\ndate: 2026-07-14\n---\n\n# New\nExact body\n";
    await writeFile(path.join(projectFolder, "plan_older.md"), older, "utf8");
    await writeFile(
      path.join(projectFolder, "analysis_new.md"),
      newer,
      "utf8",
    );

    const listed = await listHandoffs(
      { projectPath: projectRoot },
      { handoffRoot },
    );
    assert.equal(listed.scope, "project");
    assert.equal(listed.totalProjects, 1);
    assert.equal(listed.totalDocuments, 2);
    assert.deepEqual(
      listed.projects[0]!.documents.map((document) => document.label),
      ["analysis_new", "plan_older"],
    );
    assert.equal(listed.projects[0]!.documents[0]!.title, "New analysis");
    assert.equal(listed.projects[0]!.documents[0]!.date, "2026-07-14");

    const loaded = await getHandoff(
      {
        projectPath: projectRoot,
        projectSlug: "game-project",
        label: "analysis_new",
      },
      { handoffRoot },
    );
    assert.equal(loaded.documentId, "game-project/analysis_new");
    assert.equal(loaded.content, newer);

    const all = await listHandoffs({ all: true }, { handoffRoot });
    assert.equal(all.totalProjects, 2);
    assert.equal(
      all.projects.find((project) => project.projectSlug === "empty-project")
        ?.documents.length,
      0,
    );

    await assert.rejects(
      getHandoff(
        { projectSlug: "game-project", label: "../analysis_new" },
        { handoffRoot },
      ),
      (error: unknown) =>
        error instanceof HandoffStoreError && error.code === "invalid_label",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("handoff store applies the doc-handoff worktree guard", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-context-worktree-"));
  const mainRoot = path.join(root, "main-project");
  const worktreeRoot = path.join(mainRoot, ".worktrees", "feature-1");
  const handoffRoot = path.join(root, "handoff");
  const projectFolder = path.join(handoffRoot, "main-project");
  try {
    await mkdir(worktreeRoot, { recursive: true });
    await mkdir(projectFolder, { recursive: true });
    await writeFile(
      path.join(projectFolder, ".project-path"),
      `${mainRoot.replaceAll("\\", "/")}\n`,
      "utf8",
    );
    await writeFile(
      path.join(projectFolder, "notes_worktree.md"),
      "---\ntitle: Worktree notes\ndate: 2026-07-14\n---\n\n# Notes\n",
      "utf8",
    );

    const result = await listHandoffs(
      { projectPath: worktreeRoot },
      { handoffRoot },
    );
    assert.equal(result.projects[0]!.projectSlug, "main-project");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("handoff store creates, replaces, and appends documents safely", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-context-handoff-write-"));
  const projectRoot = path.join(root, "GameProject");
  const handoffRoot = path.join(root, "handoff");
  const initial =
    "---\ntitle: Automation plan\ndate: 2026-07-15\ntags: [automation]\n---\n\n# Automation plan\nInitial body\n";
  const replacement =
    "---\ntitle: Updated plan\ndate: 2026-07-16\ntags: [automation]\n---\n\n# Updated plan\nReplacement body\n";
  const preservedReplacement = replacement.replace("2026-07-16", "2026-07-15");
  try {
    await mkdir(projectRoot, { recursive: true });

    await assert.rejects(
      saveHandoff(
        { projectPath: projectRoot, label: "notes_invalid", content: "# Missing frontmatter\n" },
        { handoffRoot },
      ),
      (error: unknown) =>
        error instanceof HandoffStoreError && error.code === "invalid_content",
    );

    const created = await saveHandoff(
      { projectPath: projectRoot, label: "plan_automation", content: initial },
      { handoffRoot },
    );
    assert.equal(created.operation, "created");
    assert.equal(created.projectSlug, "gameproject");
    assert.equal(created.content, initial);
    assert.equal(
      await readFile(path.join(handoffRoot, "gameproject", ".project-path"), "utf8"),
      `${projectRoot}\n`,
    );

    await assert.rejects(
      saveHandoff(
        { projectPath: projectRoot, label: "plan_automation", content: initial },
        { handoffRoot },
      ),
      (error: unknown) =>
        error instanceof HandoffStoreError && error.code === "already_exists",
    );

    const replaced = await updateHandoff(
      { projectPath: projectRoot, label: "plan_automation", content: replacement },
      { handoffRoot },
    );
    assert.equal(replaced.operation, "replaced");
    assert.equal(replaced.content, preservedReplacement);

    const appended = await updateHandoff(
      {
        projectPath: projectRoot,
        label: "plan_automation",
        mode: "append",
        content:
          "---\ntitle: Updated plan\ndate: 2026-07-16\n---\n\n# Updated plan\n\n## Follow-up\nAppend body\n",
      },
      { handoffRoot },
    );
    assert.equal(appended.operation, "appended");
    assert.equal(
      appended.content,
      `${preservedReplacement}## Follow-up\nAppend body\n`,
    );

    await writeFile(`${appended.path}.lock`, "", "utf8");
    await assert.rejects(
      updateHandoff(
        {
          projectPath: projectRoot,
          label: "plan_automation",
          content: "## Locked append\n",
          mode: "append",
        },
        { handoffRoot },
      ),
      (error: unknown) =>
        error instanceof HandoffStoreError && error.code === "write_conflict",
    );
    await rm(`${appended.path}.lock`);

    const replacedAgain = await updateHandoff(
      {
        projectPath: projectRoot,
        label: "plan_automation",
        content:
          "---\ntitle: Updated plan\ndate: 2026-07-17\n---\n\n# Updated plan\nPreserved original date\n",
      },
      { handoffRoot },
    );
    assert.equal(replacedAgain.date, "2026-07-15");
    assert.match(replacedAgain.content, /date: 2026-07-15/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("handoff virtual paths round-trip deterministic document identifiers", () => {
  const value = handoffVirtualPath("game-project", "analysis_inventory");
  assert.equal(value, "@handoff/game-project/analysis_inventory.md");
  assert.deepEqual(parseHandoffVirtualPath(value), {
    projectSlug: "game-project",
    label: "analysis_inventory",
  });
  assert.equal(parseHandoffVirtualPath("docs/analysis_inventory.md"), null);
});
