import { spawn } from "node:child_process";
import path from "node:path";

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

const DEFAULT_DEPENDENCIES: NpmUpdaterDependencies = { runNpm };
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

  const update = await deps.runNpm(
    ["install", "--global", "project-context-mcp@latest"],
    true,
  );
  if (update.exitCode !== 0) {
    return { updated: false, message: "Update failed; npm reported an error." };
  }
  return {
    updated: true,
    message: "Updated project-context-mcp. Restart your MCP client to use the new version.",
  };
}
