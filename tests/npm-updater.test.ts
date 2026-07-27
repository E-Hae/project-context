import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  installedAdapterVersions,
  packageRootFromCliPath,
  updateGlobalNpmInstall,
} from "../src/npm-updater.js";

test("packageRootFromCliPath resolves the compiled CLI back to its package root", () => {
  const packageRoot = path.join(
    path.parse(process.cwd()).root,
    "npm",
    "node_modules",
    "project-context-mcp",
  );
  const cliPath = path.join(packageRoot, "dist", "src", "cli.js");

  assert.equal(packageRootFromCliPath(cliPath), packageRoot);
});

test("installedAdapterVersions returns versions for installed configured adapters", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-context-adapter-versions-"));
  const nodeModulesRoot = path.join(root, "node_modules");
  const packageRoot = path.join(nodeModulesRoot, "project-context-mcp");
  try {
    await mkdir(path.join(nodeModulesRoot, "project-context-mcp-csharp"), {
      recursive: true,
    });
    await mkdir(path.join(nodeModulesRoot, "@fixture", "adapter"), { recursive: true });
    await mkdir(path.join(nodeModulesRoot, "invalid-adapter"), { recursive: true });
    await writeFile(
      path.join(nodeModulesRoot, "project-context-mcp-csharp", "package.json"),
      '{"version":"1.2.3"}\n',
      "utf8",
    );
    await writeFile(
      path.join(nodeModulesRoot, "@fixture", "adapter", "package.json"),
      '{"version":"4.5.6"}\n',
      "utf8",
    );
    await writeFile(
      path.join(nodeModulesRoot, "invalid-adapter", "package.json"),
      "not valid JSON\n",
      "utf8",
    );

    const versions = await installedAdapterVersions(packageRoot, [
      "project-context-mcp-csharp",
      "missing-adapter",
      "@fixture/adapter",
      "invalid-adapter",
    ]);

    assert.deepEqual(versions, [
      { packageName: "project-context-mcp-csharp", version: "1.2.3" },
      { packageName: "@fixture/adapter", version: "4.5.6" },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("updateGlobalNpmInstall updates a matching global npm installation", async () => {
  const calls: Array<{ args: string[]; inheritOutput: boolean }> = [];

  const result = await updateGlobalNpmInstall("C:/npm/node_modules/project-context-mcp", {
    runNpm: async (args, inheritOutput) => {
      calls.push({ args, inheritOutput });
      return args[0] === "root"
        ? { exitCode: 0, stdout: "C:/npm/node_modules\n" }
        : { exitCode: 0, stdout: "" };
    },
    getTraceAdapterPackageNames: () => [],
  });

  assert.equal(result.updated, true);
  assert.match(result.message, /Restart your MCP client/);
  assert.deepEqual(calls, [
    { args: ["root", "--global"], inheritOutput: false },
    {
      args: ["install", "--global", "--prefer-online", "project-context-mcp@latest"],
      inheritOutput: true,
    },
  ]);
});

test("updateGlobalNpmInstall includes installed trace adapters", async () => {
  const calls: Array<{ args: string[]; inheritOutput: boolean }> = [];

  const result = await updateGlobalNpmInstall("C:/npm/node_modules/project-context-mcp", {
    runNpm: async (args, inheritOutput) => {
      calls.push({ args, inheritOutput });
      return args[0] === "root"
        ? { exitCode: 0, stdout: "C:/npm/node_modules\n" }
        : { exitCode: 0, stdout: "" };
    },
    getTraceAdapterPackageNames: () => ["project-context-mcp-csharp", "project-context-mcp-typescript", "fixture-python"],
    isPackageInstalled: async (_root, packageName) => packageName !== "fixture-python",
  });

  assert.equal(result.updated, true);
  assert.match(result.message, /project-context-mcp-csharp, project-context-mcp-typescript/);
  assert.deepEqual(calls, [
    { args: ["root", "--global"], inheritOutput: false },
    {
      args: [
        "install",
        "--global",
        "--prefer-online",
        "project-context-mcp@latest",
      ],
      inheritOutput: true,
    },
    {
      args: [
        "install",
        "--global",
        "--prefer-online",
        "project-context-mcp-csharp@latest",
        "project-context-mcp-typescript@latest",
      ],
      inheritOutput: true,
    },
  ]);
});

test("updateGlobalNpmInstall reports partial failure when adapters cannot update", async () => {
  const calls: string[][] = [];

  const result = await updateGlobalNpmInstall("C:/npm/node_modules/project-context-mcp", {
    runNpm: async (args) => {
      calls.push(args);
      if (args[0] === "root") {
        return { exitCode: 0, stdout: "C:/npm/node_modules\n" };
      }
      return { exitCode: args.includes("project-context-mcp-csharp@latest") ? 1 : 0, stdout: "" };
    },
    getTraceAdapterPackageNames: () => ["project-context-mcp-csharp"],
    isPackageInstalled: async () => true,
  });

  assert.equal(result.updated, false);
  assert.match(result.message, /adapter update failed/);
  assert.deepEqual(calls, [
    ["root", "--global"],
    ["install", "--global", "--prefer-online", "project-context-mcp@latest"],
    ["install", "--global", "--prefer-online", "project-context-mcp-csharp@latest"],
  ]);
});

test("updateGlobalNpmInstall leaves non-global installations unchanged", async () => {
  const calls: string[][] = [];

  const result = await updateGlobalNpmInstall("C:/temporary/project-context-mcp", {
    runNpm: async (args) => {
      calls.push(args);
      return { exitCode: 0, stdout: "C:/npm/node_modules\n" };
    },
  });

  assert.equal(result.updated, false);
  assert.match(result.message, /global npm installation/);
  assert.deepEqual(calls, [["root", "--global"]]);
});

test("updateGlobalNpmInstall gives the manual command when npm root is unavailable", async () => {
  const result = await updateGlobalNpmInstall("/temporary/project-context-mcp", {
    runNpm: async () => ({ exitCode: 1, stdout: "" }),
  });

  assert.equal(result.updated, false);
  assert.match(result.message, /npm install --global project-context-mcp@latest/);
});
