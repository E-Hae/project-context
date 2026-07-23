import type { ProjectContextConfig } from "./config.js";

type OllamaQueryExpansionConfig = Pick<
  ProjectContextConfig["services"]["ollama"],
  "url" | "queryExpansionModel"
> &
  Partial<ProjectContextConfig["services"]["ollama"]>;

export interface ExpandedQuery {
  englishQuery: string;
  codeTerms: string[];
  retrievalQuery: string;
}

export interface QueryExpansionProvider {
  readonly model: string;
  expand(query: string): Promise<ExpandedQuery>;
}

interface OllamaGenerateResponse {
  response?: unknown;
}

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    englishQuery: { type: "string" },
    codeTerms: {
      type: "array",
      items: { type: "string" },
      minItems: 1,
      maxItems: 10,
    },
  },
  required: ["englishQuery", "codeTerms"],
  additionalProperties: false,
} as const;

const SYSTEM_PROMPT =
  "Convert a Korean Unity/C# code-search question into English retrieval text. " +
  "codeTerms must include simple PascalCase class or method candidates directly " +
  "derived from the question nouns and lifecycle, including conventional Loader, " +
  "Manager, Controller, State, Event, Create, On, or Handle forms when applicable. " +
  "Preserve identifiers. Do not answer or invent project-specific facts.";

export class OllamaQueryExpander implements QueryExpansionProvider {
  readonly model: string;
  private readonly endpoint: URL;

  constructor(
    config: OllamaQueryExpansionConfig,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
    private readonly timeoutMs = 60_000,
  ) {
    if (!config.queryExpansionModel) {
      throw new Error("Query expansion model is not configured");
    }
    this.model = config.queryExpansionModel;
    const baseUrl = config.url.endsWith("/") ? config.url : `${config.url}/`;
    this.endpoint = new URL("api/generate", baseUrl);
  }

  async expand(query: string): Promise<ExpandedQuery> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          system: SYSTEM_PROMPT,
          prompt: query,
          stream: false,
          think: false,
          format: RESPONSE_SCHEMA,
          options: { temperature: 0, seed: 0, num_predict: 180 },
          keep_alive: "10m",
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 2_000).trim();
        throw new Error(
          `Ollama query expansion returned HTTP ${response.status}${
            detail ? `: ${detail}` : ""
          }`,
        );
      }
      const body = (await response.json()) as OllamaGenerateResponse;
      if (typeof body.response !== "string" || body.response.length > 8_192) {
        throw new Error("Ollama returned an invalid query expansion response");
      }
      const parsed = JSON.parse(body.response) as Record<string, unknown>;
      const englishQuery = parsed.englishQuery;
      const rawTerms = parsed.codeTerms;
      if (
        typeof englishQuery !== "string" ||
        !englishQuery.trim() ||
        englishQuery.length > 1_024 ||
        !Array.isArray(rawTerms) ||
        rawTerms.length < 1 ||
        rawTerms.length > 10 ||
        rawTerms.some(
          (term) =>
            typeof term !== "string" ||
            !term.trim() ||
            term.length > 128 ||
            term.includes("\0"),
        )
      ) {
        throw new Error("Ollama returned malformed query expansion fields");
      }
      const codeTerms = rawTerms as string[];
      const retrievalQuery = `${englishQuery.trim()} ${codeTerms
        .map((term) => term.trim())
        .join(" ")}`.slice(0, 2_048);
      return { englishQuery: englishQuery.trim(), codeTerms, retrievalQuery };
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`Ollama query expansion timed out after ${this.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
