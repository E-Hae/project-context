import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";

import { configuredTraceAdapterNames } from "./trace-adapter-resolver.js";

export interface NpmUpdateResult {
  updated: boolean;
  message: string;
}

interface NpmCommandResult {
  exitCode: number;
  stdout: string;
}

interface NpmUpdaterDependencies {
  runNpm: (args: string[], inheritOutput: boolean) => Promise<NpmCommandResult>;
  getTraceAdapterPackageNames: () => readonly string[];
  isPackageInstalled: (globalPackageRoot: string, packageName: string) => Promise<boolean>;
}

function pathKey(value: string): string {
  const normalized = path.normalize(value).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function packageRootFromCliPath(cliPath: string): string {
  return path.resolve(path.dirname(cliPath), "..", "..");
}

function runNpm(args: string[], inheritOutput: boolean): Promise<NpmCommandResult> {
  return new Promise((resolve, reject) => {
    const isWindows = process.platform === "win32";
    const child = spawn(
      isWindows ? (process.env.ComSpec ?? "cmd.exe") : "npm",
      isWindows ? ["/d", "/s", "/c", "npm.cmd", ...args] : args,
      {
        stdio: inheritOutput ? "inherit" : ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let stdout = "";
    if (!inheritOutput) {
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
      });
    }
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({ exitCode: code ?? 1, stdout });
    });
  });
}

async function isPackageInstalled(
  globalPackageRoot: string,
  packageName: string,
): Promise<boolean> {
  try {
    await stat(path.join(globalPackageRoot, ...packageName.split("/")));
    return true;
  } catch {
    return false;
  }
}

const DEFAULT_DEPENDENCIES: NpmUpdaterDependencies = {
  runNpm,
  getTraceAdapterPackageNames: configuredTraceAdapterNames,
  isPackageInstalled,
};
const GLOBAL_INSTALL_REQUIRED_MESSAGE =
  "pctx update requires a global npm installation. Run npm install --global project-context-mcp@latest.";

export async function updateGlobalNpmInstall(
  currentPackageRoot: string,
  dependencies: Partial<NpmUpdaterDependencies> = {},
): Promise<NpmUpdateResult> {
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  let root: NpmCommandResult;
  try {
    root = await deps.runNpm(["root", "--global"], false);
  } catch {
    return { updated: false, message: GLOBAL_INSTALL_REQUIRED_MESSAGE };
  }
  if (root.exitCode !== 0 || !root.stdout.trim()) {
    return { updated: false, message: GLOBAL_INSTALL_REQUIRED_MESSAGE };
  }

  const globalPackageRoot = path.join(root.stdout.trim(), "project-context-mcp");
  if (pathKey(currentPackageRoot) !== pathKey(globalPackageRoot)) {
    return {
      updated: false,
      message: GLOBAL_INSTALL_REQUIRED_MESSAGE,
    };
  }

  const installedAdapters = (await Promise.all(
    deps
      .getTraceAdapterPackageNames()
      .filter((packageName) => packageName !== "project-context-mcp")
      .map(async (packageName) =>
        (await deps.isPackageInstalled(root.stdout.trim(), packageName))
          ? packageName
          : null,
      ),
  )).filter((packageName): packageName is string => packageName !== null);
  const coreUpdate = await deps.runNpm(
    ["install", "--global", "project-context-mcp@latest"],
    true,
  );
  if (coreUpdate.exitCode !== 0) {
    return { updated: false, message: "Update failed; npm reported an error." };
  }

  if (installedAdapters.length === 0) {
    return {
      updated: true,
      message: "Updated project-context-mcp. Restart your MCP client to use the new version.",
    };
  }

  const adapterUpdate = await deps.runNpm(
    ["install", "--global", ...installedAdapters.map((packageName) => `${packageName}@latest`)],
    true,
  );
  if (adapterUpdate.exitCode !== 0) {
    return {
      updated: false,
      message: `Updated project-context-mcp, but trace adapter update failed for ${installedAdapters.join(", ")}.`,
    };
  }

  return {
    updated: true,
    message: `Updated project-context-mcp and ${installedAdapters.join(", ")}. Restart your MCP client to use the new version.`,
  };
}
