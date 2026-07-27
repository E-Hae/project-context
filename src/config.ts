import { readFile } from "node:fs/promises";
import path from "node:path";

import { parse as parseYaml } from "yaml";
import { z } from "zod/v4";

import type { VectorStoreBackend } from "./vector-store.js";

export const PROJECT_CONFIG_DIRECTORY = ".project-context";
export const PROJECT_CONFIG_FILENAME = "config.yml";
export const PROJECT_CONFIG_RELATIVE_PATH = path.join(
  PROJECT_CONFIG_DIRECTORY,
  PROJECT_CONFIG_FILENAME,
);

const DEFAULT_EXCLUDES = [
  ".git/**",
  ".codegraph/**",
  "Library/**",
  "Temp/**",
  "Logs/**",
  "obj/**",
  "Build/**",
  "Builds/**",
  "UserSettings/**",
  "**/node_modules/**",
];

export interface ProjectContextConfig {
  version: 1;
  sources: {
    code: string[];
    documents: string[];
    semanticExclude: string[];
    handoff: {
      enabled: boolean;
      projectSlug: string | null;
    };
  };
  exclude: string[];
  services: {
    ollama: {
      url: string;
      embeddingModel: string;
      queryExpansionModel: string | null;
    };
    milvus: {
      address: string;
    };
    vectorStore: {
      backend: VectorStoreBackend;
    };
  };
  adapters: {
    unity: {
      mode: "yaml" | "batch";
      editorVersion: string | null;
      batchTimeoutSeconds: number;
    };
    git: {
      historyLimit: number;
    };
  };
}

export const DEFAULT_CONFIG: ProjectContextConfig = {
  version: 1,
  sources: {
    code: ["."],
    documents: ["README.md", "docs"],
    semanticExclude: [],
    handoff: {
      enabled: false,
      projectSlug: null,
    },
  },
  exclude: DEFAULT_EXCLUDES,
  services: {
    ollama: {
      url: "http://127.0.0.1:11434",
      embeddingModel: "nomic-embed-text:v1.5",
      queryExpansionModel: null,
    },
    milvus: {
      address: "127.0.0.1:19530",
    },
    vectorStore: {
      backend: "local",
    },
  },
  adapters: {
    unity: {
      mode: "yaml",
      editorVersion: null,
      batchTimeoutSeconds: 120,
    },
    git: {
      historyLimit: 200,
    },
  },
};

const rawConfigSchema = z
  .object({
    version: z.literal(1).optional(),
    sources: z
      .object({
        code: z.array(z.string().min(1).max(512)).max(128).optional(),
        documents: z.array(z.string().min(1).max(512)).max(128).optional(),
        semanticExclude: z.array(z.string().min(1).max(512)).max(256).optional(),
        handoff: z
          .object({
            enabled: z.boolean().optional(),
            projectSlug: z.string().min(1).nullable().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    exclude: z.array(z.string().min(1).max(512)).max(256).optional(),
    services: z
      .object({
        ollama: z
          .object({
            url: z.url().optional(),
            embeddingModel: z.string().min(1).optional(),
            queryExpansionModel: z.string().min(1).nullable().optional(),
          })
          .strict()
          .optional(),
        milvus: z
          .object({
            address: z.string().min(1).optional(),
          })
          .strict()
          .optional(),
        vectorStore: z
          .object({
            backend: z.enum(["local", "milvus"]).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    adapters: z
      .object({
        unity: z
          .object({
            mode: z.enum(["yaml", "batch"]).optional(),
            editorVersion: z.string().min(1).max(128).nullable().optional(),
            batchTimeoutSeconds: z.number().int().min(10).max(3_600).optional(),
          })
          .strict()
          .optional(),
        git: z
          .object({
            historyLimit: z.number().int().min(1).max(5_000).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export interface LoadedProjectConfig {
  path: string;
  exists: boolean;
  valid: boolean;
  errors: string[];
  value: ProjectContextConfig;
}

function mergeConfig(raw: z.infer<typeof rawConfigSchema>): ProjectContextConfig {
  return {
    version: 1,
    sources: {
      code: raw.sources?.code ?? DEFAULT_CONFIG.sources.code,
      documents: raw.sources?.documents ?? DEFAULT_CONFIG.sources.documents,
      semanticExclude:
        raw.sources?.semanticExclude ?? DEFAULT_CONFIG.sources.semanticExclude,
      handoff: {
        enabled:
          raw.sources?.handoff?.enabled ?? DEFAULT_CONFIG.sources.handoff.enabled,
        projectSlug:
          raw.sources?.handoff?.projectSlug ??
          DEFAULT_CONFIG.sources.handoff.projectSlug,
      },
    },
    exclude: raw.exclude ?? DEFAULT_CONFIG.exclude,
    services: {
      ollama: {
        url: raw.services?.ollama?.url ?? DEFAULT_CONFIG.services.ollama.url,
        embeddingModel:
          raw.services?.ollama?.embeddingModel ??
          DEFAULT_CONFIG.services.ollama.embeddingModel,
        queryExpansionModel:
          raw.services?.ollama?.queryExpansionModel === undefined
            ? DEFAULT_CONFIG.services.ollama.queryExpansionModel
            : raw.services.ollama.queryExpansionModel,
      },
      milvus: {
        address:
          raw.services?.milvus?.address ?? DEFAULT_CONFIG.services.milvus.address,
      },
      vectorStore: {
        backend:
          raw.services?.vectorStore?.backend ??
          (raw.services?.milvus === undefined ? "local" : "milvus"),
      },
    },
    adapters: {
      unity: {
        mode: raw.adapters?.unity?.mode ?? DEFAULT_CONFIG.adapters.unity.mode,
        editorVersion:
          raw.adapters?.unity?.editorVersion === undefined
            ? DEFAULT_CONFIG.adapters.unity.editorVersion
            : raw.adapters.unity.editorVersion,
        batchTimeoutSeconds:
          raw.adapters?.unity?.batchTimeoutSeconds ??
          DEFAULT_CONFIG.adapters.unity.batchTimeoutSeconds,
      },
      git: {
        historyLimit:
          raw.adapters?.git?.historyLimit ?? DEFAULT_CONFIG.adapters.git.historyLimit,
      },
    },
  };
}

function formatZodErrors(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const location = issue.path.length > 0 ? issue.path.join(".") : "config";
    return `${location}: ${issue.message}`;
  });
}

export async function loadProjectConfig(
  projectRoot: string,
): Promise<LoadedProjectConfig> {
  const configPath = path.join(projectRoot, PROJECT_CONFIG_RELATIVE_PATH);

  let source: string;
  try {
    source = await readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        path: configPath,
        exists: false,
        valid: true,
        errors: [],
        value: DEFAULT_CONFIG,
      };
    }

    return {
      path: configPath,
      exists: true,
      valid: false,
      errors: [error instanceof Error ? error.message : String(error)],
      value: DEFAULT_CONFIG,
    };
  }

  try {
    const parsed = rawConfigSchema.safeParse(parseYaml(source));
    if (!parsed.success) {
      return {
        path: configPath,
        exists: true,
        valid: false,
        errors: formatZodErrors(parsed.error),
        value: DEFAULT_CONFIG,
      };
    }

    return {
      path: configPath,
      exists: true,
      valid: true,
      errors: [],
      value: mergeConfig(parsed.data),
    };
  } catch (error) {
    return {
      path: configPath,
      exists: true,
      valid: false,
      errors: [error instanceof Error ? error.message : String(error)],
      value: DEFAULT_CONFIG,
    };
  }
}
