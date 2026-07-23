---
title: Project Context MCP
date: 2026-07-16
tags: [mcp, rag, code-search]
---

# Project Context MCP

`project-context` is a local MCP server and CLI for deterministic project
checks, exact search, semantic search, bounded source reads, Roslyn-backed C#
relationship tracing, and explicit handoff access.

It includes MCP tools for status, search, reads, relationship tracing, and
handoffs. The CLI can incrementally index configured project code and documents
into a local Milvus collection. `project-context ask` retrieves source evidence,
asks a local Ollama model for a grounded answer, and prints the supporting file
and line ranges.

## Requirements

- Node.js 20 or newer
- .NET 8 or newer for C# graph tracing
- `rg`
- For semantic search: Ollama with `nomic-embed-text:v1.5` and a REST
  v2-compatible Milvus instance
- For `ask`: a local Ollama answer model (default: `qwen3.5:9b`)

## Install and run

```powershell
npm install
npm run build
npm run build:roslyn
node dist/src/cli.js status C:\path\to\project
node dist/src/cli.js index C:\path\to\project
node dist/src/cli.js search C:\path\to\project "Loader.CreateLoadingState callers" graph code 50
node dist/src/cli.js trace C:\path\to\project Loader.CreateLoadingState callees 50
node dist/src/cli.js read C:\path\to\project Assets/Scripts/File.cs 1 200
node dist/src/cli.js ask C:\path\to\project "Where is session restore handled?"
node dist/src/cli.js serve --mcp
```

For a full build and test run:

```powershell
npm test
npm run test:roslyn
```

## Project configuration

Place `.project-context.yml` at the project root.

```yaml
version: 1
sources:
  code: [src]
  documents: [README.md, docs]
  handoff:
    enabled: true
    projectSlug: example-project
exclude:
  - node_modules/**
  - "**/*.dll"
services:
  ollama:
    url: http://127.0.0.1:11434
    embeddingModel: nomic-embed-text:v1.5
    answerModel: qwen3.5:9b
    queryExpansionModel: qwen3.5:9b
  milvus:
    address: 127.0.0.1:19530
```

Add every secret-bearing or generated path to `exclude` before indexing. The
same source policy is applied to exact search, bounded reads, indexing,
semantic evidence, and Roslyn graph tracing. Excluded content is not used as
evidence. Set `PROJECT_CONTEXT_MILVUS_TOKEN` only when Milvus authentication is
enabled.

`PROJECT_CONTEXT_STATE_ROOT` can redirect index state, and
`PROJECT_CONTEXT_HANDOFF_ROOT` can redirect handoff storage for isolated tests
or automation. The indexer never writes files in the indexed project.

## Behavior

`context_status` reports project configuration, `rg`, Ollama, Milvus, Roslyn
worker, handoff registration, and index freshness. It returns `ready`,
`degraded`, or `unavailable` with deterministic diagnostics.

Exact search uses `rg --json --fixed-strings`. Semantic search stores
project-isolated vectors, validates source hashes before returning a result, and
returns at most one best chunk per file. `context_read` resolves paths before
reading, rejects project-root escapes and disallowed files, and returns at most
400 lines.

`context_trace` uses a local Roslyn worker for C# `callers`, `callees`,
`inherits`, and `implements` relationships. It only returns edges resolved by
the semantic model; ambiguity and unresolved calls are reported instead of
guessed.

`context_handoff_save` only creates a new complete Markdown document, while
`context_handoff_update` explicitly replaces or appends to one. Both use
temporary files, preserving the original document date on replacement and
avoiding partial reads.

## License

The project source is [MIT licensed](LICENSE). See
[third-party notices](THIRD_PARTY_NOTICES.md) for dependency licenses.
