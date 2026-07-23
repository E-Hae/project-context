import type { ProjectContextConfig } from "./config.js";

type OllamaEmbeddingConfig = Pick<
  ProjectContextConfig["services"]["ollama"],
  "url" | "embeddingModel"
> &
  Partial<ProjectContextConfig["services"]["ollama"]>;

export interface EmbeddingProvider {
  readonly model: string;
  probeDimension(): Promise<number>;
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
}

export async function withEmbeddingRetry<T>(
  operation: () => Promise<T>,
  sleep: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const transient =
        /lacked sufficient buffer space|queue was full|ECONNRESET|ECONNREFUSED|ECONNABORTED|EPIPE|ETIMEDOUT|fetch failed|timed out|HTTP (?:408|425|429|5\d\d)/i.test(
          message,
        );
      if (!transient || attempt === 3) throw error;
      await sleep(500 * 2 ** attempt);
    }
  }
  throw new Error("Embedding retry loop ended unexpectedly");
}

interface OllamaEmbedResponse {
  model?: unknown;
  embeddings?: unknown;
}

export class OllamaEmbeddingClient implements EmbeddingProvider {
  readonly model: string;
  private readonly endpoint: URL;

  constructor(
    config: OllamaEmbeddingConfig,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
    private readonly timeoutMs = 120_000,
  ) {
    this.model = config.embeddingModel;
    const baseUrl = config.url.endsWith("/") ? config.url : `${config.url}/`;
    this.endpoint = new URL("api/embed", baseUrl);
  }

  private async embed(texts: string[], prefix: "search_document" | "search_query") {
    if (texts.length < 1 || texts.length > 64) {
      throw new Error("Embedding requests must contain between 1 and 64 texts");
    }
    if (texts.some((text) => !text.trim() || text.includes("\0"))) {
      throw new Error("Embedding input contains empty or invalid text");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          input: texts.map((text) => `${prefix}: ${text}`),
          truncate: false,
          keep_alive: "10m",
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 2_000).trim();
        throw new Error(
          `Ollama embed returned HTTP ${response.status}${
            detail ? `: ${detail}` : ""
          }`,
        );
      }
      const body = (await response.json()) as OllamaEmbedResponse;
      if (body.model !== this.model) {
        const returnedModel =
          typeof body.model === "string" ? body.model.slice(0, 512) : "<missing>";
        throw new Error(
          `Ollama returned embedding model ${returnedModel}; expected ${this.model}`,
        );
      }
      if (!Array.isArray(body.embeddings) || body.embeddings.length !== texts.length) {
        throw new Error("Ollama returned an unexpected embedding count");
      }
      let dimension: number | null = null;
      const vectors = body.embeddings.map((candidate) => {
        if (
          !Array.isArray(candidate) ||
          candidate.length < 2 ||
          candidate.length > 32_768 ||
          candidate.some((value) => typeof value !== "number" || !Number.isFinite(value))
        ) {
          throw new Error("Ollama returned an invalid embedding vector");
        }
        dimension ??= candidate.length;
        if (candidate.length !== dimension) {
          throw new Error("Ollama returned inconsistent embedding dimensions");
        }
        return candidate as number[];
      });
      return vectors;
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`Ollama embed timed out after ${this.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async probeDimension(): Promise<number> {
    const vectors = await this.embed(["project context dimension probe"], "search_document");
    return vectors[0]!.length;
  }

  embedDocuments(texts: string[]): Promise<number[][]> {
    return this.embed(texts, "search_document");
  }

  async embedQuery(text: string): Promise<number[]> {
    const vectors = await this.embed([text], "search_query");
    return vectors[0]!;
  }
}
