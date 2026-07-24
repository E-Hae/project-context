import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
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

test("updateGlobalNpmInstall updates a matching global npm installation", async () => {
  const calls: Array<{ args: string[]; inheritOutput: boolean }> = [];

  const result = await updateGlobalNpmInstall("C:/npm/node_modules/project-context-mcp", {
    runNpm: async (args, inheritOutput) => {
      calls.push({ args, inheritOutput });
      return args[0] === "root"
        ? { exitCode: 0, stdout: "C:/npm/node_modules\n" }
        : { exitCode: 0, stdout: "" };
    },
  });

  assert.equal(result.updated, true);
  assert.match(result.message, /Restart your MCP client/);
  assert.deepEqual(calls, [
    { args: ["root", "--global"], inheritOutput: false },
    {
      args: ["install", "--global", "project-context-mcp@latest"],
      inheritOutput: true,
    },
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
