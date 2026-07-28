import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));

function runCli(
  args: string[],
  handoffRoot: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [cliPath, ...args],
      {
        encoding: "utf8",
        env: { ...process.env, PROJECT_CONTEXT_HANDOFF_ROOT: handoffRoot },
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(`${error.message}\n${stderr}`));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

function runCliWithInput(
  args: string[],
  input: string,
  handoffRoot: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: { ...process.env, PROJECT_CONTEXT_HANDOFF_ROOT: handoffRoot },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(`CLI exited with ${code}: ${stderr}`));
        return;
      }
      resolve({ stdout, stderr });
    });
    child.stdin.end(input, "utf8");
  });
}

test("CLI prints help successfully", async () => {
  const result = await runCli(["--help"], tmpdir());

  assert.match(result.stdout, /pctx search/);
  assert.match(result.stdout, /max-results.*language/);
  assert.match(result.stdout, /pctx update/);
  assert.doesNotMatch(result.stdout, /pctx ask/);
  assert.equal(result.stderr, "");
});

test("CLI prints the package version", async () => {
  const packageJson = JSON.parse(
    await readFile(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
  ) as { version: string };

  for (const option of ["--version", "-v"]) {
    const result = await runCli([option], tmpdir());
    assert.equal(result.stdout, `${packageJson.version}\n`);
    assert.equal(result.stderr, "");
  }
});

test("CLI saves and appends handoffs without an MCP client", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-context-cli-"));
  const projectRoot = path.join(root, "AutomationProject");
  const handoffRoot = path.join(root, "handoff");
  const documentPath = path.join(root, "document.md");
  const appendPath = path.join(root, "append.md");
  try {
    await mkdir(projectRoot, { recursive: true });
    await writeFile(
      documentPath,
      "---\ntitle: CLI handoff\ndate: 2026-07-15\n---\n\n# CLI handoff\nInitial body\n",
      "utf8",
    );
    await writeFile(appendPath, "## Follow-up\nAppended through CLI\n", "utf8");

    const saved = await runCli(
      ["handoff", "save", projectRoot, "notes_cli", "--file", documentPath],
      handoffRoot,
    );
    const savedResult = JSON.parse(saved.stdout) as { operation?: unknown };
    assert.equal(savedResult.operation, "created");

    const updated = await runCliWithInput(
      [
        "handoff",
        "update",
        projectRoot,
        "notes_cli",
        "--stdin",
        "--append",
      ],
      await readFile(appendPath, "utf8"),
      handoffRoot,
    );
    const updatedResult = JSON.parse(updated.stdout) as {
      operation?: unknown;
      content?: unknown;
    };
    assert.equal(updatedResult.operation, "appended");
    assert.equal(
      updatedResult.content,
      "---\ntitle: CLI handoff\ndate: 2026-07-15\n---\n\n# CLI handoff\nInitial body\n## Follow-up\nAppended through CLI\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
