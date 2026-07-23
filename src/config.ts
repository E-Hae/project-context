import { readFile } from "node:fs/promises";
import path from "node:path";

import { parse as parseYaml } from "yaml";
import { z } from "zod/v4";

export const PROJECT_CONFIG_FILENAME = ".project-context.yml";

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
      answerModel: string;
      queryExpansionModel: string | null;
    };
    milvus: {
      address: string;
    };
  };
}

export const DEFAULT_CONFIG: ProjectContextConfig = {
  version: 1,
  sources: {
    code: ["."],
    documents: ["README.md", "docs"],
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
      answerModel: "qwen3.5:9b",
      queryExpansionModel: null,
    },
    milvus: {
      address: "127.0.0.1:19530",
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
            answerModel: z.string().min(1).optional(),
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
        answerModel:
          raw.services?.ollama?.answerModel ??
          DEFAULT_CONFIG.services.ollama.answerModel,
        queryExpansionModel:
          raw.services?.ollama?.queryExpansionModel === undefined
            ? DEFAULT_CONFIG.services.ollama.queryExpansionModel
            : raw.services.ollama.queryExpansionModel,
      },
      milvus: {
        address:
          raw.services?.milvus?.address ?? DEFAULT_CONFIG.services.milvus.address,
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
  const configPath = path.join(projectRoot, PROJECT_CONFIG_FILENAME);

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
