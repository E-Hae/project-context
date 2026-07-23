import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  ProjectContextVectorStore,
  VectorEntity,
  VectorSearchHit,
} from "./vector-store.js";

interface LocalCollection {
  version: 1;
  collectionName: string;
  dimension: number;
  entities: VectorEntity[];
}

const COLLECTION_DIRECTORY = "local-vectors";
const MAX_COLLECTION_BYTES = 64 * 1024 * 1024;

function collectionPath(stateRoot: string, collectionName: string): string {
  const key = createHash("sha256").update(collectionName).digest("hex");
  return path.join(stateRoot, COLLECTION_DIRECTORY, `${key}.json`);
}

function validateCollectionName(collectionName: string): void {
  if (!collectionName || collectionName.length > 255) {
    throw new Error("Local vector collection name is invalid");
  }
}

function validateDimension(dimension: number): void {
  if (!Number.isInteger(dimension) || dimension < 2 || dimension > 32_768) {
    throw new Error("Local vector embedding dimension is invalid");
  }
}

function validateVector(vector: number[], dimension: number): void {
  if (
    vector.length !== dimension ||
    vector.some((value) => typeof value !== "number" || !Number.isFinite(value))
  ) {
    throw new Error("Local vector embedding does not match the collection dimension");
  }
}

function isVectorEntity(candidate: unknown, dimension: number): candidate is VectorEntity {
  if (typeof candidate !== "object" || candidate === null) return false;
  const entity = candidate as Record<string, unknown>;
  return (
    typeof entity.id === "string" &&
    Array.isArray(entity.embedding) &&
    entity.embedding.length === dimension &&
    entity.embedding.every(
      (value) => typeof value === "number" && Number.isFinite(value),
    ) &&
    typeof entity.project === "string" &&
    (entity.source === "code" || entity.source === "document") &&
    typeof entity.path === "string" &&
    typeof entity.lineStart === "number" &&
    typeof entity.lineEnd === "number" &&
    typeof entity.content === "string" &&
    typeof entity.fileHash === "string" &&
    typeof entity.indexedAt === "string" &&
    typeof entity.commit === "string"
  );
}

function parseCollection(value: unknown, expectedName: string): LocalCollection {
  if (typeof value !== "object" || value === null) {
    throw new Error("Local vector collection is invalid");
  }
  const collection = value as Record<string, unknown>;
  const dimension = collection.dimension;
  if (
    collection.version !== 1 ||
    collection.collectionName !== expectedName ||
    typeof dimension !== "number" ||
    !Array.isArray(collection.entities)
  ) {
    throw new Error("Local vector collection is invalid");
  }
  validateDimension(dimension);
  if (!collection.entities.every((entity) => isVectorEntity(entity, dimension))) {
    throw new Error("Local vector collection contains invalid entities");
  }
  return {
    version: 1,
    collectionName: expectedName,
    dimension,
    entities: collection.entities,
  };
}

function cosine(left: number[], right: number[]): number {
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index]!;
    const rightValue = right[index]!;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  const denominator = Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude);
  return denominator === 0 ? 0 : dot / denominator;
}

function compareIds(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export class LocalVectorStore implements ProjectContextVectorStore {
  constructor(private readonly stateRoot: string) {}

  private async load(collectionName: string): Promise<LocalCollection | null> {
    validateCollectionName(collectionName);
    const filePath = collectionPath(this.stateRoot, collectionName);
    try {
      const fileStat = await stat(filePath);
      if (!fileStat.isFile() || fileStat.size > MAX_COLLECTION_BYTES) {
        throw new Error("Local vector collection is not a regular file or exceeds 64 MiB");
      }
      return parseCollection(JSON.parse(await readFile(filePath, "utf8")), collectionName);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async save(collection: LocalCollection): Promise<void> {
    const serialized = `${JSON.stringify(collection)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_COLLECTION_BYTES) {
      throw new Error("Local vector collection exceeds 64 MiB");
    }
    const filePath = collectionPath(this.stateRoot, collection.collectionName);
    await mkdir(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(temporaryPath, serialized, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporaryPath, filePath);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }

  async hasCollection(collectionName: string): Promise<boolean> {
    return (await this.load(collectionName)) !== null;
  }

  async ensureCollection(collectionName: string, dimension: number): Promise<void> {
    validateDimension(dimension);
    const existing = await this.load(collectionName);
    if (existing === null) {
      await this.save({
        version: 1,
        collectionName,
        dimension,
        entities: [],
      });
      return;
    }
    if (existing.dimension !== dimension) {
      throw new Error("Local vector collection dimension does not match the requested dimension");
    }
  }

  async dropCollection(collectionName: string): Promise<void> {
    validateCollectionName(collectionName);
    await rm(collectionPath(this.stateRoot, collectionName), { force: true });
  }

  async upsert(collectionName: string, entities: VectorEntity[]): Promise<void> {
    if (entities.length === 0) return;
    if (entities.length > 64) {
      throw new Error("Local vector upsert batch exceeds 64 entities");
    }
    const collection = await this.load(collectionName);
    if (collection === null) throw new Error("Local vector collection is missing");
    const entityById = new Map(collection.entities.map((entity) => [entity.id, entity]));
    for (const entity of entities) {
      validateVector(entity.embedding, collection.dimension);
      entityById.set(entity.id, entity);
    }
    collection.entities = [...entityById.values()];
    await this.save(collection);
  }

  async deleteIds(collectionName: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    if (ids.some((id) => !/^[a-f0-9]{64}$/.test(id))) {
      throw new Error("Local vector deletion contains an invalid chunk ID");
    }
    const collection = await this.load(collectionName);
    if (collection === null) throw new Error("Local vector collection is missing");
    const deleted = new Set(ids);
    collection.entities = collection.entities.filter((entity) => !deleted.has(entity.id));
    await this.save(collection);
  }

  async search(
    collectionName: string,
    vector: number[],
    limit: number,
  ): Promise<VectorSearchHit[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new Error("Local vector search limit must be between 1 and 200");
    }
    const collection = await this.load(collectionName);
    if (collection === null) throw new Error("Local vector collection is missing");
    validateVector(vector, collection.dimension);
    return collection.entities
      .map((entity) => ({
        id: entity.id,
        source: entity.source,
        path: entity.path,
        lineStart: entity.lineStart,
        lineEnd: entity.lineEnd,
        content: entity.content,
        fileHash: entity.fileHash,
        indexedAt: entity.indexedAt,
        commit: entity.commit || null,
        score: cosine(vector, entity.embedding),
      }))
      .sort((left, right) => right.score - left.score || compareIds(left.id, right.id))
      .slice(0, limit);
  }
}
