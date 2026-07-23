import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
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

async function startOllamaStub(): Promise<{
  url: string;
  requests: unknown[];
  close: () => Promise<void>;
}> {
  const requests: unknown[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.once("end", () => {
      requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ response: "RestoreSession handles session recovery. [S1]" }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo | null;
  if (address === null) throw new Error("Ollama stub did not bind an address");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}

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

test("CLI ask generates a locally grounded answer with verified sources", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-context-cli-ask-"));
  const projectRoot = path.join(root, "AutomationProject");
  const handoffRoot = path.join(root, "handoff");
  const ollama = await startOllamaStub();
  try {
    await mkdir(path.join(projectRoot, "src"), { recursive: true });
    await writeFile(
      path.join(projectRoot, ".project-context.yml"),
      [
        "version: 1",
        "sources:",
        "  code: [src]",
        "  documents: []",
        "services:",
        "  ollama:",
        `    url: ${ollama.url}`,
        "    answerModel: fixture-answer",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(projectRoot, "src", "Session.cs"),
      "public class Session {\n  void RestoreSession() {}\n}\n",
      "utf8",
    );

    const result = await runCli(
      ["ask", projectRoot, "RestoreSession"],
      handoffRoot,
    );

    assert.match(result.stdout, /RestoreSession handles session recovery\. \[S1\]/);
    assert.match(result.stdout, /\[S1\] src\/Session\.cs:1-3/);
    assert.equal(ollama.requests.length, 1);
    const request = ollama.requests[0] as Record<string, unknown>;
    assert.equal(request.model, "fixture-answer");
    assert.equal(request.stream, false);
    assert.equal(request.think, false);
    assert.match(String(request.prompt), /RestoreSession/);
    assert.deepEqual(request.options, { temperature: 0, seed: 0, num_predict: 900 });
    assert.equal(request.keep_alive, "10m");
  } finally {
    await ollama.close();
    await rm(root, { recursive: true, force: true });
  }
});
