#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import process from "node:process";

import { readProjectDocument } from "./document-store.js";
import { traceProject, type TraceDirection } from "./graph-client.js";
import { saveHandoff, updateHandoff } from "./handoff-store.js";
import { searchProject, type SearchMode } from "./hybrid-search.js";
import { indexProject } from "./indexer.js";
import { serveMcp } from "./mcp-server.js";
import { collectProjectStatus } from "./status.js";
import { watchProject } from "./watcher.js";

function printUsage(stream: NodeJS.WriteStream = process.stderr): void {
  stream.write(
    [
      "Usage:",
      "  pctx index <project-root> [--rebuild]",
      "  pctx watch <project-root> [interval-ms]",
      "  pctx status [project-root]",
      "  pctx search <project-root> <query> [auto|exact|graph|semantic] [all|code|documents] [max-results]",
      "  pctx trace <project-root> <symbol> <callers|callees|inherits|implements> [max-results] [language]",
      "  pctx read <project-root> <path> [start-line] [end-line]",
      "  pctx handoff save <project-root> <label> (--file <markdown-file> | --stdin)",
      "  pctx handoff update <project-root> <label> (--file <markdown-file> | --stdin) [--append]",
      "  pctx serve --mcp",
      "",
    ].join("\n"),
  );
}

async function readStandardInput(): Promise<string> {
  return new Promise((resolve, reject) => {
    let content = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      content += chunk;
    });
    process.stdin.once("end", () => resolve(content));
    process.stdin.once("error", reject);
  });
}

async function readHandoffContent(
  args: string[],
): Promise<{ content: string; append: boolean }> {
  let filePath: string | undefined;
  let useStandardInput = false;
  let append = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--file") {
      const next = args[index + 1];
      if (next === undefined || filePath !== undefined || useStandardInput) {
        throw new Error("handoff --file requires one file path and cannot be combined with --stdin");
      }
      filePath = next;
      index += 1;
      continue;
    }
    if (argument === "--stdin") {
      if (filePath !== undefined || useStandardInput) {
        throw new Error("handoff content source must be specified exactly once");
      }
      useStandardInput = true;
      continue;
    }
    if (argument === "--append") {
      append = true;
      continue;
    }
    throw new Error(`Unknown handoff option: ${argument}`);
  }

  if (filePath === undefined && !useStandardInput) {
    throw new Error("handoff requires either --file <markdown-file> or --stdin");
  }
  return {
    content: filePath === undefined ? await readStandardInput() : await readFile(filePath, "utf8"),
    append,
  };
}

function handoffOptions(): { handoffRoot?: string } {
  const handoffRoot = process.env.PROJECT_CONTEXT_HANDOFF_ROOT;
  return handoffRoot ? { handoffRoot } : {};
}

async function main(args: string[]): Promise<number> {
  const [command, ...rest] = args;

  if ((command === "--help" || command === "-h") && rest.length === 0) {
    printUsage(process.stdout);
    return 0;
  }

  if (command === "status") {
    const projectRoot = rest[0] ?? process.cwd();
    const status = await collectProjectStatus(projectRoot);
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    return status.status === "unavailable" ? 1 : 0;
  }

  if (
    command === "index" &&
    (rest.length === 1 || (rest.length === 2 && rest[1] === "--rebuild"))
  ) {
    let lastReported = -1;
    let lastPhase = "";
    const stateRoot = process.env.PROJECT_CONTEXT_STATE_ROOT;
    const result = await indexProject(rest[0]!, {
      ...(stateRoot ? { stateRoot } : {}),
      forceRebuild: rest[1] === "--rebuild",
      onProgress: (progress) => {
        if (progress.phase !== lastPhase) {
          lastPhase = progress.phase;
          lastReported = -1;
        }
        if (
          progress.phase === "index" &&
          progress.current !== progress.total &&
          progress.current - lastReported < 50
        ) {
          return;
        }
        lastReported = progress.current;
        process.stderr.write(
          `[${progress.phase}] ${progress.current}/${progress.total}${
            progress.path ? ` ${progress.path}` : ""
          }\n`,
        );
      },
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }

  if (command === "watch" && rest.length >= 1 && rest.length <= 2) {
    const intervalMs = rest[1] === undefined ? 300_000 : Number(rest[1]);
    const stateRoot = process.env.PROJECT_CONTEXT_STATE_ROOT;
    const controller = new AbortController();
    const stop = (): void => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      await watchProject(rest[0]!, {
        intervalMs,
        signal: controller.signal,
        ...(stateRoot ? { stateRoot } : {}),
        onEvent: (event) => {
          process.stderr.write(`${JSON.stringify(event)}\n`);
        },
      });
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    }
    return 0;
  }

  if (command === "serve" && rest.length === 1 && rest[0] === "--mcp") {
    await serveMcp();
    return 0;
  }

  if (command === "handoff" && rest.length >= 3) {
    const [operation, projectPath, label, ...contentArgs] = rest;
    if (operation !== "save" && operation !== "update") {
      throw new Error("handoff operation must be save or update");
    }
    const { content, append } = await readHandoffContent(contentArgs);
    if (operation === "save" && append) {
      throw new Error("handoff save does not support --append");
    }
    const result =
      operation === "save"
        ? await saveHandoff(
            { projectPath: projectPath!, label: label!, content },
            handoffOptions(),
          )
        : await updateHandoff(
            {
              projectPath: projectPath!,
              label: label!,
              content,
              mode: append ? "append" : "replace",
            },
            handoffOptions(),
          );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }

  if (command === "search" && rest.length >= 2) {
    const [projectPath, query] = rest;
    let argumentIndex = 2;
    const modeValue = rest[argumentIndex];
    const mode =
      modeValue === "auto" ||
      modeValue === "exact" ||
      modeValue === "graph" ||
      modeValue === "semantic"
        ? modeValue
        : "auto";
    if (
      modeValue === "auto" ||
      modeValue === "exact" ||
      modeValue === "graph" ||
      modeValue === "semantic"
    ) {
      argumentIndex += 1;
    }
    const scopeValue = rest[argumentIndex];
    let scope: "all" | "code" | "documents" = "all";
    if (
      scopeValue === "all" ||
      scopeValue === "code" ||
      scopeValue === "documents"
    ) {
      scope = scopeValue;
      argumentIndex += 1;
    } else if (
      scopeValue !== undefined &&
      !Number.isFinite(Number(scopeValue))
    ) {
      throw new Error("scope must be all, code, or documents");
    }
    const maxResultsValue = rest[argumentIndex];
    const maxResults = maxResultsValue === undefined ? 50 : Number(maxResultsValue);
    const stateRoot = process.env.PROJECT_CONTEXT_STATE_ROOT;
    const result = await searchProject(
      {
        projectPath: projectPath!,
        query: query!,
        mode: mode as SearchMode,
        scope,
        maxResults,
      },
      stateRoot ? { stateRoot } : {},
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }

  if (command === "read" && rest.length >= 2) {
    const [projectPath, filePath, startLineValue, endLineValue] = rest;
    const startLine = startLineValue === undefined ? 1 : Number(startLineValue);
    const endLine = endLineValue === undefined ? undefined : Number(endLineValue);
    const result = await readProjectDocument({
      projectPath: projectPath!,
      path: filePath!,
      startLine,
      ...(endLine === undefined ? {} : { endLine }),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }

  if (command === "trace" && rest.length >= 3 && rest.length <= 5) {
    const [projectPath, symbol, directionValue, maxResultsValue, language] = rest;
    if (
      directionValue !== "callers" &&
      directionValue !== "callees" &&
      directionValue !== "inherits" &&
      directionValue !== "implements"
    ) {
      throw new Error("direction must be callers, callees, inherits, or implements");
    }
    const maxResults = maxResultsValue === undefined ? 50 : Number(maxResultsValue);
    const result = await traceProject({
      projectPath: projectPath!,
      symbol: symbol!,
      direction: directionValue as TraceDirection,
      maxResults,
      ...(language === undefined ? {} : { language }),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }

  printUsage();
  return 1;
}

main(process.argv.slice(2))
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
