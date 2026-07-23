import path from "node:path";

export interface DocumentChunk {
  ordinal: number;
  lineStart: number;
  lineEnd: number;
  text: string;
}

export interface ChunkDocumentInput {
  path: string;
  text: string;
  targetCharacters?: number;
  maxCharacters?: number;
}

interface LineRange {
  start: number;
  end: number;
}

type ChunkRange = LineRange & { text?: string };

const DEFAULT_TARGET_CHARACTERS = 1_200;
const DEFAULT_MAX_CHARACTERS = 1_600;
const CSHARP_BOUNDARY_SCAN_LIMIT = DEFAULT_MAX_CHARACTERS;

function rangeLength(lines: string[], range: LineRange): number {
  let length = 0;
  for (let index = range.start; index < range.end; index += 1) {
    length += lines[index]?.length ?? 0;
    if (index + 1 < range.end) length += 1;
  }
  return length;
}

function isCSharpBoundary(line: string): boolean {
  const trimmed = line.trim();
  if (
    !trimmed ||
    trimmed.length > CSHARP_BOUNDARY_SCAN_LIMIT ||
    trimmed.startsWith("//")
  ) {
    return false;
  }
  if (
    /^(?:(?:public|private|protected|internal|static|abstract|sealed|partial|readonly|ref|unsafe|new)\s+)*(?:class|struct|interface|enum|record)\b/.test(
      trimmed,
    )
  ) {
    return true;
  }
  if (!trimmed.includes("(") || !/\)\s*(?:=>|\{|where\b|;)?\s*$/.test(trimmed)) {
    return false;
  }
  if (/^(?:if|for|foreach|while|switch|catch|using|lock|return|throw|new)\b/.test(trimmed)) {
    return false;
  }
  return /^(?:(?:public|private|protected|internal|static|virtual|override|abstract|async|extern|unsafe|sealed|new|partial)\s+)+(?:[\w.<>,\[\]?]+\s+)?(?:\w+|operator\s+\S+)\s*\(|^(?:void|bool|byte|short|int|long|float|double|decimal|string|object|[A-Z]\w*(?:<[^>]+>)?)\s+\w+\s*\(/.test(
    trimmed,
  );
}

function preferredBoundaries(relativePath: string, lines: string[]): number[] {
  const extension = path.extname(relativePath).toLowerCase();
  const starts = new Set<number>([0]);
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (extension === ".md" && /^#{1,6}\s+\S/.test(line)) {
      starts.add(index);
    } else if (extension === ".cs" && isCSharpBoundary(line)) {
      starts.add(index);
    }
  }
  return [...starts].sort((left, right) => left - right);
}

function splitOversizedRange(
  lines: string[],
  range: LineRange,
  maxCharacters: number,
): ChunkRange[] {
  const output: ChunkRange[] = [];
  let start = range.start;
  let length = 0;

  const flush = (end: number): void => {
    if (end > start) output.push({ start, end });
    start = end;
    length = 0;
  };

  for (let index = range.start; index < range.end; index += 1) {
    const line = lines[index] ?? "";
    if (line.length > maxCharacters) {
      flush(index);
      for (let offset = 0; offset < line.length; offset += maxCharacters) {
        output.push({
          start: index,
          end: index + 1,
          text: line.slice(offset, offset + maxCharacters),
        });
      }
      start = index + 1;
      continue;
    }

    const nextLength = length + (length === 0 ? 0 : 1) + line.length;
    if (length > 0 && nextLength > maxCharacters) {
      flush(index);
      length = line.length;
    } else {
      length = nextLength;
    }
  }
  flush(range.end);
  return output;
}

export function chunkDocument(input: ChunkDocumentInput): DocumentChunk[] {
  const targetCharacters =
    input.targetCharacters ?? DEFAULT_TARGET_CHARACTERS;
  const maxCharacters = input.maxCharacters ?? DEFAULT_MAX_CHARACTERS;
  if (
    !Number.isInteger(targetCharacters) ||
    !Number.isInteger(maxCharacters) ||
    targetCharacters < 1 ||
    maxCharacters < targetCharacters
  ) {
    throw new Error(
      "Chunk character limits must be positive integers with max >= target",
    );
  }

  const normalized = input.text.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  if (lines.length === 0 || (lines.length === 1 && lines[0] === "")) return [];

  const boundaries = preferredBoundaries(input.path, lines);
  const sections: LineRange[] = boundaries.map((start, index) => ({
    start,
    end: boundaries[index + 1] ?? lines.length,
  }));

  const packed: LineRange[] = [];
  let current: LineRange | null = null;
  for (const section of sections) {
    const sectionLength = rangeLength(lines, section);
    if (sectionLength > maxCharacters) {
      if (current !== null) packed.push(current);
      current = null;
      packed.push(section);
      continue;
    }
    if (current === null) {
      current = { ...section };
      continue;
    }
    const combined: LineRange = { start: current.start, end: section.end };
    if (rangeLength(lines, combined) <= targetCharacters) {
      current = combined;
    } else {
      packed.push(current);
      current = { ...section };
    }
  }
  if (current !== null) packed.push(current);

  const chunks: DocumentChunk[] = [];
  for (const range of packed) {
    const pieces: ChunkRange[] =
      rangeLength(lines, range) > maxCharacters
        ? splitOversizedRange(lines, range, maxCharacters)
        : [range];
    for (const piece of pieces) {
      const text = piece.text ?? lines.slice(piece.start, piece.end).join("\n");
      if (!text.trim()) continue;
      chunks.push({
        ordinal: chunks.length,
        lineStart: piece.start + 1,
        lineEnd: piece.end,
        text,
      });
    }
  }
  return chunks;
}
