import type { TraceAdapter } from "./trace-adapter.js";

const DEFAULT_TRACE_ADAPTERS = ["project-context-mcp-csharp"];
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/iu;

export interface TraceAdapterSelection {
  language?: string;
  sourceFileExtensions?: readonly string[];
}

export interface TraceAdapterDiagnostic {
  packageName: string;
  detail: string;
}

export interface TraceAdapterDiscovery {
  candidates: string[];
  adapters: TraceAdapter[];
  diagnostics: TraceAdapterDiagnostic[];
}

export interface TraceAdapterResolverOptions {
  packageNames?: readonly string[];
  loadModule?: (packageName: string) => Promise<unknown>;
}

export class TraceAdapterUnavailableError extends Error {
  constructor(
    readonly language: string | null,
    readonly candidates: string[],
  ) {
    super(
      language === null
        ? "No compatible trace adapter is installed. Install a language adapter and try again."
        : `No compatible ${language} trace adapter is installed. Install a compatible trace adapter and try again.`,
    );
    this.name = "TraceAdapterUnavailableError";
  }
}

export class TraceAdapterLanguageRequiredError extends Error {
  constructor(readonly candidates: string[]) {
    super(
      `More than one trace adapter matches this project (${candidates.join(", ")}). Specify a language.`,
    );
    this.name = "TraceAdapterLanguageRequiredError";
  }
}

export class TraceAdapterContractError extends Error {
  constructor(readonly diagnostics: TraceAdapterDiagnostic[]) {
    super(diagnostics.map((diagnostic) => diagnostic.detail).join("; "));
    this.name = "TraceAdapterContractError";
  }
}

export function configuredTraceAdapterNames(
  configured = process.env.PROJECT_CONTEXT_TRACE_ADAPTERS,
): string[] {
  const additional = configured
    ?.split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .filter((value) => PACKAGE_NAME_PATTERN.test(value)) ?? [];
  return [...new Set([...DEFAULT_TRACE_ADAPTERS, ...additional])];
}

function isTraceAdapter(candidate: unknown): candidate is TraceAdapter {
  if (typeof candidate !== "object" || candidate === null) return false;
  const adapter = candidate as Record<string, unknown>;
  return (
    typeof adapter.name === "string" &&
    typeof adapter.language === "string" &&
    Array.isArray(adapter.sourceFileExtensions) &&
    adapter.sourceFileExtensions.every((extension) => typeof extension === "string") &&
    (adapter.auxiliaryFileExtensions === undefined ||
      (Array.isArray(adapter.auxiliaryFileExtensions) &&
        adapter.auxiliaryFileExtensions.every((extension) => typeof extension === "string"))) &&
    typeof adapter.probe === "function" &&
    typeof adapter.trace === "function"
  );
}

function missingPackage(error: unknown, packageName: string): boolean {
  if (typeof error !== "object" || error === null) return false;
  const value = error as { code?: unknown; message?: unknown };
  return (
    value.code === "ERR_MODULE_NOT_FOUND" &&
    typeof value.message === "string" &&
    value.message.includes(`Cannot find package '${packageName}'`)
  );
}

function normalizedLanguage(value: string | undefined): string | null {
  return value?.trim().toLocaleLowerCase("en-US") || null;
}

function normalizedExtensions(values: readonly string[] | undefined): Set<string> {
  return new Set(
    (values ?? [])
      .map((value) => value.trim().toLocaleLowerCase("en-US"))
      .filter((value) => value.startsWith(".")),
  );
}

export async function discoverTraceAdapters(
  options: TraceAdapterResolverOptions = {},
): Promise<TraceAdapterDiscovery> {
  const candidates = options.packageNames === undefined
    ? configuredTraceAdapterNames()
    : [...new Set(options.packageNames)];
  const loadModule = options.loadModule ?? ((packageName) => import(packageName));
  const adapters: TraceAdapter[] = [];
  const diagnostics: TraceAdapterDiagnostic[] = [];

  for (const packageName of candidates) {
    try {
      const loaded = await loadModule(packageName);
      const adapter = (loaded as { traceAdapter?: unknown }).traceAdapter;
      if (!isTraceAdapter(adapter)) {
        diagnostics.push({
          packageName,
          detail: `${packageName} does not export a valid traceAdapter contract`,
        });
        continue;
      }
      adapters.push(adapter);
    } catch (error) {
      if (missingPackage(error, packageName)) continue;
      diagnostics.push({
        packageName,
        detail: `Unable to load trace adapter ${packageName}: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  return { candidates, adapters, diagnostics };
}

export async function resolveTraceAdapter(
  selection: TraceAdapterSelection = {},
  options: TraceAdapterResolverOptions = {},
): Promise<TraceAdapter> {
  const discovery = await discoverTraceAdapters(options);
  if (discovery.adapters.length === 0) {
    if (discovery.diagnostics.length > 0) {
      throw new TraceAdapterContractError(discovery.diagnostics);
    }
    throw new TraceAdapterUnavailableError(
      normalizedLanguage(selection.language),
      discovery.candidates,
    );
  }

  const language = normalizedLanguage(selection.language);
  const sourceFileExtensions = normalizedExtensions(selection.sourceFileExtensions);
  const matching = discovery.adapters.filter((adapter) => {
    if (language !== null && adapter.language.toLocaleLowerCase("en-US") !== language) {
      return false;
    }
    if (sourceFileExtensions.size === 0) return true;
    return adapter.sourceFileExtensions.some((extension) =>
      sourceFileExtensions.has(extension.toLocaleLowerCase("en-US")),
    );
  });

  if (matching.length === 0) {
    throw new TraceAdapterUnavailableError(language, discovery.candidates);
  }
  if (language === null && matching.length > 1) {
    throw new TraceAdapterLanguageRequiredError(matching.map((adapter) => adapter.name));
  }
  return matching[0]!;
}
