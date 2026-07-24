import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v4";

import { readProjectDocument } from "./document-store.js";
import { traceProject } from "./graph-client.js";
import { analyzeProjectImpact } from "./impact-client.js";
import {
  getHandoff,
  listHandoffs,
  saveHandoff,
  updateHandoff,
} from "./handoff-store.js";
import { searchProject } from "./hybrid-search.js";
import { collectProjectStatus } from "./status.js";

export interface ProjectContextServerOptions {
  handoffRoot?: string;
  trace?: typeof traceProject;
  impact?: typeof analyzeProjectImpact;
  search?: typeof searchProject;
}

export function createProjectContextServer(
  options: ProjectContextServerOptions = {},
): McpServer {
  const server = new McpServer(
    {
      name: "project-context",
      version: "0.1.0",
    },
    {
      instructions:
        "Use context_status before project-context operations to verify project scope and local dependencies.",
    },
  );

  server.registerTool(
    "context_status",
    {
      title: "Project context status",
      description:
        "Checks the project root, configuration, ripgrep, Ollama embedding model, selected vector store, trace-adapter capability, and handoff registration.",
      inputSchema: {
        projectPath: z.string().min(1).describe("Absolute or relative project path"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ projectPath }) => {
      try {
        const result = await collectProjectStatus(projectPath);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
          structuredContent: { ...result },
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: error instanceof Error ? error.message : String(error),
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "context_search",
    {
      title: "Project context search",
      description:
        "Searches configured project context with explicit exact, graph, or semantic routing, or a bounded auto route with one empty-result fallback.",
      inputSchema: {
        projectPath: z.string().min(1).describe("Absolute or relative project path"),
        query: z.string().min(1).max(2_048).describe("Text or question to search for"),
        mode: z.enum(["auto", "exact", "graph", "semantic"]).default("auto"),
        scope: z.enum(["all", "code", "documents"]).default("all"),
        maxResults: z.number().int().min(1).max(200).default(50),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ projectPath, query, mode, scope, maxResults }) => {
      try {
        const result = await (options.search ?? searchProject)({
          projectPath,
          query,
          mode,
          scope,
          maxResults,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: { ...result },
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: error instanceof Error ? error.message : String(error),
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "context_read",
    {
      title: "Read project file range",
      description:
        "Reads up to 400 lines from a configured, non-excluded text file without allowing project-root escape.",
      inputSchema: {
        projectPath: z.string().min(1).describe("Absolute or relative project path"),
        path: z.string().min(1).max(2_048).describe("Project-relative file path"),
        startLine: z.number().int().min(1).default(1),
        endLine: z.number().int().min(1).optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ projectPath, path, startLine, endLine }) => {
      try {
        const result = await readProjectDocument({
          projectPath,
          path,
          startLine,
          ...(endLine === undefined ? {} : { endLine }),
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: { ...result },
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: error instanceof Error ? error.message : String(error),
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "context_trace",
    {
      title: "Trace symbol relationships",
      description:
        "Uses a selected trace adapter to return source-backed callers, callees, inheritance, or interface relationships without guessing unresolved edges.",
      inputSchema: {
        projectPath: z.string().min(1).describe("Absolute or relative project path"),
        symbol: z
          .string()
          .min(1)
          .max(512)
          .describe("Symbol such as Namespace.Type.Member"),
        direction: z.enum(["callers", "callees", "inherits", "implements"]),
        maxResults: z.number().int().min(1).max(200).default(50),
        language: z.string().min(1).max(128).optional().describe("Trace adapter language when more than one adapter matches"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ projectPath, symbol, direction, maxResults, language }) => {
      try {
        const result = await (options.trace ?? traceProject)({
          projectPath,
          symbol,
          direction,
          maxResults,
          ...(language === undefined ? {} : { language }),
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: { ...result },
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: error instanceof Error ? error.message : String(error),
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "context_impact",
    {
      title: "Analyze change impact",
      description: "Uses an installed impact adapter to identify files that historically change together with a project file.",
      inputSchema: {
        projectPath: z.string().min(1).describe("Absolute or relative project path"),
        target: z.string().min(1).max(4_096).describe("Project-relative file path"),
        maxResults: z.number().int().min(1).max(200).default(50),
        language: z.string().min(1).max(128).optional().describe("Impact adapter language; defaults to git"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ projectPath, target, maxResults, language }) => {
      try {
        const result = await (options.impact ?? analyzeProjectImpact)({
          projectPath,
          target,
          maxResults,
          ...(language === undefined ? {} : { language }),
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: { ...result } };
      } catch (error) {
        return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
      }
    },
  );

  server.registerTool(
    "context_handoff_list",
    {
      title: "List project handoffs",
      description:
        "Lists deterministic Markdown handoff metadata from the registered project folder without using Milvus or modifying files.",
      inputSchema: {
        projectPath: z
          .string()
          .min(1)
          .optional()
          .describe("Project path; defaults to the server working directory"),
        projectSlug: z
          .string()
          .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
          .optional()
          .describe("Registered handoff project slug"),
        all: z
          .boolean()
          .default(false)
          .describe("List every registered handoff project"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ projectPath, projectSlug, all }) => {
      try {
        const result = await listHandoffs(
          {
            ...(projectPath === undefined ? {} : { projectPath }),
            ...(projectSlug === undefined ? {} : { projectSlug }),
            all,
          },
          options,
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: { ...result },
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: error instanceof Error ? error.message : String(error),
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "context_handoff_get",
    {
      title: "Read project handoff",
      description:
        "Reads one registered handoff Markdown document verbatim by label without using Milvus or modifying files.",
      inputSchema: {
        label: z
          .string()
          .regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/)
          .describe("Handoff filename stem"),
        projectPath: z
          .string()
          .min(1)
          .optional()
          .describe("Project path; defaults to the server working directory"),
        projectSlug: z
          .string()
          .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
          .optional()
          .describe("Registered handoff project slug"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ label, projectPath, projectSlug }) => {
      try {
        const result = await getHandoff(
          {
            label,
            ...(projectPath === undefined ? {} : { projectPath }),
            ...(projectSlug === undefined ? {} : { projectSlug }),
          },
          options,
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: { ...result },
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: error instanceof Error ? error.message : String(error),
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "context_handoff_save",
    {
      title: "Create project handoff",
      description:
        "Creates one Markdown handoff from explicit content without overwriting an existing document.",
      inputSchema: {
        label: z
          .string()
          .regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/)
          .describe("Handoff filename stem"),
        content: z.string().min(1).describe("Complete Markdown document with frontmatter"),
        projectPath: z
          .string()
          .min(1)
          .optional()
          .describe("Project path; defaults to the server working directory"),
        projectSlug: z
          .string()
          .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
          .optional()
          .describe("Registered handoff project slug"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ label, content, projectPath, projectSlug }) => {
      try {
        const result = await saveHandoff(
          {
            label,
            content,
            ...(projectPath === undefined ? {} : { projectPath }),
            ...(projectSlug === undefined ? {} : { projectSlug }),
          },
          options,
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: { ...result },
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: error instanceof Error ? error.message : String(error),
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "context_handoff_update",
    {
      title: "Update project handoff",
      description:
        "Replaces a complete handoff document or appends a Markdown body to an existing handoff.",
      inputSchema: {
        label: z
          .string()
          .regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/)
          .describe("Handoff filename stem"),
        content: z.string().min(1).describe("Complete Markdown document or append body"),
        mode: z.enum(["replace", "append"]).default("replace"),
        projectPath: z
          .string()
          .min(1)
          .optional()
          .describe("Project path; defaults to the server working directory"),
        projectSlug: z
          .string()
          .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
          .optional()
          .describe("Registered handoff project slug"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ label, content, mode, projectPath, projectSlug }) => {
      try {
        const result = await updateHandoff(
          {
            label,
            content,
            mode,
            ...(projectPath === undefined ? {} : { projectPath }),
            ...(projectSlug === undefined ? {} : { projectSlug }),
          },
          options,
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: { ...result },
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: error instanceof Error ? error.message : String(error),
            },
          ],
          isError: true,
        };
      }
    },
  );

  return server;
}

export async function serveMcp(): Promise<void> {
  const handoffRoot = process.env.PROJECT_CONTEXT_HANDOFF_ROOT;
  const server = createProjectContextServer(
    handoffRoot ? { handoffRoot } : {},
  );
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
