import type { ProjectContextConfig } from "./config.js";
import type { SourceKind } from "./source-policy.js";

export interface VectorEntity {
  id: string;
  embedding: number[];
  project: string;
  source: SourceKind;
  path: string;
  lineStart: number;
  lineEnd: number;
  content: string;
  fileHash: string;
  indexedAt: string;
  commit: string;
}

export interface VectorSearchHit {
  id: string;
  source: SourceKind;
  path: string;
  lineStart: number;
  lineEnd: number;
  content: string;
  fileHash: string;
  indexedAt: string;
  commit: string | null;
  score: number;
}

export interface CollectionLoadState {
  state: string;
  progress: number | null;
}

export interface ProjectContextVectorStore {
  hasCollection(collectionName: string): Promise<boolean>;
  ensureCollection(collectionName: string, dimension: number): Promise<void>;
  dropCollection(collectionName: string): Promise<void>;
  upsert(collectionName: string, entities: VectorEntity[]): Promise<void>;
  deleteIds(collectionName: string, ids: string[]): Promise<void>;
  search(
    collectionName: string,
    vector: number[],
    limit: number,
  ): Promise<VectorSearchHit[]>;
}

interface MilvusResponse {
  code?: unknown;
  message?: unknown;
  data?: unknown;
}

function normalizeAddress(address: string): string {
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(address)
    ? address
    : `http://${address}`;
  return withProtocol.endsWith("/") ? withProtocol : `${withProtocol}/`;
}

function objectValue(candidate: unknown, key: string): unknown {
  if (typeof candidate !== "object" || candidate === null) return undefined;
  const record = candidate as Record<string, unknown>;
  if (record[key] !== undefined) return record[key];
  const dynamic = record.$meta;
  return typeof dynamic === "object" && dynamic !== null
    ? (dynamic as Record<string, unknown>)[key]
    : undefined;
}

export class MilvusRestClient implements ProjectContextVectorStore {
  private readonly baseUrl: string;

  constructor(
    config: ProjectContextConfig["services"]["milvus"],
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
    private readonly timeoutMs = 30_000,
    private readonly token = process.env.PROJECT_CONTEXT_MILVUS_TOKEN,
  ) {
    this.baseUrl = normalizeAddress(config.address);
  }

  private async request(endpoint: string, body: Record<string, unknown>) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "request-timeout": String(Math.max(1, Math.ceil(this.timeoutMs / 1_000))),
      };
      if (this.token) headers.authorization = `Bearer ${this.token}`;
      const response = await this.fetchImpl(new URL(endpoint, this.baseUrl), {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 2_000).trim();
        throw new Error(
          `Milvus returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
        );
      }
      const payload = (await response.json()) as MilvusResponse;
      if (payload.code !== 0) {
        throw new Error(
          `Milvus request failed: ${
            typeof payload.message === "string" ? payload.message : "unknown error"
          }`,
        );
      }
      return payload.data;
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`Milvus request timed out after ${this.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async hasCollection(collectionName: string): Promise<boolean> {
    const data = await this.request("v2/vectordb/collections/has", {
      collectionName,
    });
    const has = objectValue(data, "has");
    if (typeof has !== "boolean") {
      throw new Error("Milvus returned an invalid collection existence response");
    }
    return has;
  }

  async getCollectionLoadState(
    collectionName: string,
  ): Promise<CollectionLoadState> {
    const data = await this.request("v2/vectordb/collections/get_load_state", {
      collectionName,
    });
    const state = objectValue(data, "loadState");
    const progress = objectValue(data, "loadProgress");
    if (typeof state !== "string") {
      throw new Error("Milvus returned an invalid collection load state");
    }
    return {
      state,
      progress:
        typeof progress === "number" && Number.isFinite(progress)
          ? progress
          : null,
    };
  }

  async ensureCollection(collectionName: string, dimension: number): Promise<void> {
    if (!Number.isInteger(dimension) || dimension < 2 || dimension > 32_768) {
      throw new Error("Milvus embedding dimension is invalid");
    }
    if (await this.hasCollection(collectionName)) return;
    try {
      await this.request("v2/vectordb/collections/create", {
        collectionName,
        dimension,
        metricType: "COSINE",
        idType: "VarChar",
        autoId: false,
        primaryFieldName: "id",
        vectorFieldName: "embedding",
        consistencyLevel: "Strong",
        params: { max_length: "64" },
      });
    } catch (error) {
      if (!(await this.hasCollection(collectionName))) throw error;
    }
  }

  async dropCollection(collectionName: string): Promise<void> {
    if (!(await this.hasCollection(collectionName))) return;
    await this.request("v2/vectordb/collections/drop", { collectionName });
  }

  async upsert(collectionName: string, entities: VectorEntity[]): Promise<void> {
    if (entities.length === 0) return;
    if (entities.length > 64) throw new Error("Milvus upsert batch exceeds 64 entities");
    await this.request("v2/vectordb/entities/upsert", {
      collectionName,
      data: entities,
    });
  }

  async deleteIds(collectionName: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    if (ids.some((id) => !/^[a-f0-9]{64}$/.test(id))) {
      throw new Error("Milvus deletion contains an invalid chunk ID");
    }
    await this.request("v2/vectordb/entities/delete", {
      collectionName,
      filter: `id in [${ids.map((id) => JSON.stringify(id)).join(",")}]`,
    });
  }

  async search(
    collectionName: string,
    vector: number[],
    limit: number,
  ): Promise<VectorSearchHit[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new Error("Milvus search limit must be between 1 and 200");
    }
    const data = await this.request("v2/vectordb/entities/search", {
      collectionName,
      data: [vector],
      annsField: "embedding",
      limit,
      consistencyLevel: "Strong",
      searchParams: { metricType: "COSINE", params: {} },
      outputFields: [
        "source",
        "path",
        "lineStart",
        "lineEnd",
        "content",
        "fileHash",
        "indexedAt",
        "commit",
      ],
    });
    if (!Array.isArray(data)) {
      throw new Error("Milvus returned an invalid search response");
    }
    return data.map((candidate) => {
      const id = objectValue(candidate, "id");
      const source = objectValue(candidate, "source");
      const resultPath = objectValue(candidate, "path");
      const lineStart = objectValue(candidate, "lineStart");
      const lineEnd = objectValue(candidate, "lineEnd");
      const content = objectValue(candidate, "content");
      const fileHash = objectValue(candidate, "fileHash");
      const indexedAt = objectValue(candidate, "indexedAt");
      const commit = objectValue(candidate, "commit");
      const score = objectValue(candidate, "distance");
      if (
        typeof id !== "string" ||
        (source !== "code" && source !== "document") ||
        typeof resultPath !== "string" ||
        typeof lineStart !== "number" ||
        typeof lineEnd !== "number" ||
        typeof content !== "string" ||
        typeof fileHash !== "string" ||
        typeof indexedAt !== "string" ||
        typeof score !== "number" ||
        !Number.isFinite(score)
      ) {
        throw new Error("Milvus returned invalid semantic-search evidence");
      }
      return {
        id,
        source,
        path: resultPath,
        lineStart,
        lineEnd,
        content,
        fileHash,
        indexedAt,
        commit: typeof commit === "string" && commit ? commit : null,
        score,
      };
    });
  }
}
