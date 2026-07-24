import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { ImpactAdapter } from "./impact-adapter.js";

const DEFAULT_IMPACT_ADAPTERS = ["project-context-mcp-git"];
const requireForResolver = createRequire(import.meta.url);
let globalNodeModulesRootPromise: Promise<string | null> | undefined;

export function configuredImpactAdapterNames(
  configured = process.env.PROJECT_CONTEXT_IMPACT_ADAPTERS,
): string[] {
  const additional = configured?.split(",")
    .map((value) => value.trim())
    .filter((value) => /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/iu.test(value)) ?? [];
  return [...new Set([...DEFAULT_IMPACT_ADAPTERS, ...additional])];
}

function isImpactAdapter(value: unknown): value is ImpactAdapter {
  if (typeof value !== "object" || value === null) return false;
  const adapter = value as Record<string, unknown>;
  return typeof adapter.name === "string" &&
    typeof adapter.language === "string" &&
    typeof adapter.probe === "function" &&
    typeof adapter.analyze === "function";
}

function missingPackage(error: unknown, packageName: string): boolean {
  return typeof error === "object" && error !== null &&
    (error as { code?: unknown }).code === "ERR_MODULE_NOT_FOUND" &&
    String((error as { message?: unknown }).message).includes(`Cannot find package '${packageName}'`);
}

function globalNodeModulesRoot(): Promise<string | null> {
  if (globalNodeModulesRootPromise !== undefined) return globalNodeModulesRootPromise;
  globalNodeModulesRootPromise = new Promise((resolve) => execFile(
    process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "npm",
    process.platform === "win32" ? ["/d", "/s", "/c", "npm.cmd", "root", "--global"] : ["root", "--global"],
    { encoding: "utf8", timeout: 5_000, windowsHide: true },
    (error, stdout) => {
      const candidate = stdout.trim().split(/\r?\n/u).at(-1)?.trim() ?? "";
      resolve(error === null && candidate && path.isAbsolute(candidate) ? path.normalize(candidate) : null);
    },
  ));
  return globalNodeModulesRootPromise;
}

async function loadAdapter(packageName: string): Promise<unknown> {
  try {
    return await import(packageName);
  } catch (error) {
    if (!missingPackage(error, packageName)) throw error;
    const globalRoot = await globalNodeModulesRoot();
    if (globalRoot === null) throw error;
    try {
      const resolved = requireForResolver.resolve(packageName, { paths: [path.dirname(globalRoot)] });
      return import(pathToFileURL(resolved).href);
    } catch {
      throw error;
    }
  }
}

export async function resolveImpactAdapter(language = "git"): Promise<ImpactAdapter> {
  const normalized = language.trim().toLocaleLowerCase("en-US");
  for (const packageName of configuredImpactAdapterNames()) {
    try {
      const loaded = await loadAdapter(packageName);
      const adapter = (loaded as { impactAdapter?: unknown }).impactAdapter;
      if (isImpactAdapter(adapter) && adapter.language.toLocaleLowerCase("en-US") === normalized) {
        return adapter;
      }
    } catch (error) {
      if (!missingPackage(error, packageName)) {
        throw new Error(`Unable to load impact adapter ${packageName}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  throw new Error(`No compatible ${normalized} impact adapter is installed. Install a compatible impact adapter and try again.`);
}
