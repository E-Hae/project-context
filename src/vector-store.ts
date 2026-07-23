import type { ProjectContextConfig } from "./config.js";
import { LocalVectorStore } from "./local-vector-store.js";
import { MilvusRestClient } from "./milvus-rest-client.js";
import type { SourceKind } from "./source-policy.js";

export type VectorStoreBackend = "local" | "milvus";

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

export function createVectorStore(
  config: ProjectContextConfig,
  stateRoot: string,
): ProjectContextVectorStore {
  if (config.services.vectorStore.backend === "milvus") {
    return new MilvusRestClient(config.services.milvus);
  }
  return new LocalVectorStore(stateRoot);
}
