import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface RoslynTraceWorkerRequest {
  version: 1;
  projectRoot: string;
  files: string[];
  assemblyDefinitions: string[];
  symbol: string;
  direction: "callers" | "callees" | "inherits" | "implements";
  maxResults: number;
}

export interface RoslynGraphWorkerRequest {
  version: 1;
  operation: "build_graph";
  projectRoot: string;
  files: string[];
  assemblyDefinitions: string[];
  maxNodes: number;
  maxEdges: number;
}

export type RoslynWorkerRequest = RoslynTraceWorkerRequest | RoslynGraphWorkerRequest;

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PACKAGE_ROOT = path.resolve(moduleDirectory, "..", "..");
const MAX_WORKER_OUTPUT_BYTES = 32 * 1024 * 1024;

export function getRoslynWorkerPath(packageRoot = DEFAULT_PACKAGE_ROOT): string {
  return path.join(
    packageRoot,
    "workers",
    "roslyn",
    "bin",
    "Release",
    "net8.0",
    "ProjectContext.Roslyn.dll",
  );
}

export function runRoslynWorker(
  request: RoslynWorkerRequest,
  workerPath = getRoslynWorkerPath(),
  timeoutMs = 90_000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn("dotnet", [workerPath], {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const finishError = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      reject(error);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout, "utf8") > MAX_WORKER_OUTPUT_BYTES) {
        finishError(new Error("Roslyn worker output exceeded the size limit"));
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (Buffer.byteLength(stderr, "utf8") < 256 * 1024) stderr += chunk;
    });
    child.once("error", finishError);
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`Roslyn worker timed out after ${timeoutMs}ms`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout.trim()) as unknown;
        if (code !== 0 && code !== 1) {
          reject(new Error(stderr.trim() || `Roslyn worker exited with code ${String(code)}`));
          return;
        }
        resolve(parsed);
      } catch {
        reject(
          new Error(
            stderr.trim() || `Roslyn worker returned invalid JSON (exit ${String(code)})`,
          ),
        );
      }
    });
    child.stdin.once("error", finishError);
    child.stdin.end(JSON.stringify(request));
  });
}

export function probeRoslynWorker(
  workerPath = getRoslynWorkerPath(),
  timeoutMs = 5_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("dotnet", [workerPath, "--version"], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finishError = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      reject(error);
    };
    const timer = setTimeout(() => {
      finishError(new Error(`Roslyn worker probe timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout, "utf8") > 4_096) {
        finishError(new Error("Roslyn worker probe output exceeded the size limit"));
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (Buffer.byteLength(stderr, "utf8") < 4_096) stderr += chunk;
    });
    child.once("error", finishError);
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const version = stdout.trim();
      if (code !== 0 || !version) {
        reject(new Error(stderr.trim() || `Roslyn worker probe exited with code ${String(code)}`));
        return;
      }
      resolve(version);
    });
  });
}
