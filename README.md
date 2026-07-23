# Project Context MCP

[![npm version](https://img.shields.io/npm/v/project-context-mcp.svg)](https://www.npmjs.com/package/project-context-mcp)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js 20+](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)](https://nodejs.org/)

`project-context` is an evidence-first local MCP server and CLI for navigating
codebases. It performs deterministic status checks, exact and semantic search,
bounded source reads, Roslyn-backed C# relationship tracing, and explicit
handoff access.

It is designed to keep source evidence local: the tool talks only to the local
or self-hosted services you configure. Search results include source paths and
line ranges so an agent or developer can verify the underlying code.

## Features

| Capability | What it does |
| --- | --- |
| Exact search | Fast, deterministic `rg` search with configured source and exclusion rules. |
| Semantic search | Project-isolated embeddings in Milvus, validated against current file hashes. |
| C# graph tracing | Roslyn-based callers, callees, inheritance, and implementation relationships. |
| Bounded reads | Reads only configured project files and returns a limited source range. |
| Handoffs | Lists, reads, creates, and updates explicit Markdown handoff documents safely. |

## Quick start

Install the CLI globally:

```sh
npm install --global project-context-mcp
project-context --help
```

Then add a `.project-context.yml` file to the project you want to inspect and
run a status check:

```sh
project-context status /path/to/project
project-context index /path/to/project
project-context search /path/to/project "session restore" auto code 10
```

On Windows, quote paths that contain spaces:

```powershell
project-context status 'C:\work\my project'
```

### Connect an MCP client

Add this standard MCP server entry to your client's configuration:

```json
{
  "mcpServers": {
    "project-context": {
      "command": "project-context",
      "args": ["serve", "--mcp"]
    }
  }
}
```

The server exposes `context_status`, `context_search`, `context_read`,
`context_trace`, and the `context_handoff_*` tools. Start with
`context_status` to confirm the selected project and local dependencies.

## Requirements

- Node.js 20 or newer
- `rg` (ripgrep) for exact search
- .NET 8 runtime for C# relationship tracing; the Roslyn worker is included in
  the npm package
- Ollama with `nomic-embed-text:v1.5` and a REST v2-compatible Milvus instance
  for semantic search
- A local Ollama answer model for `ask` (default: `qwen3.5:9b`)

Exact search, bounded reads, status checks, and handoff access do not require
Ollama or Milvus. `context_trace` does not require either service.

## Project configuration

Configuration is optional. Create `.project-context.yml` in the target project
root when you want to narrow the indexed sources or add project-specific
exclusions. The example below contains only project-owned paths; it does not
include a user home directory, account, token, or machine-specific setting.

```yaml
version: 1
sources:
  code: [src]
  documents: [README.md, docs]
exclude:
  - node_modules/**
  - .git/**
  - "**/*.dll"
  - "**/*.keystore"
```

### Optional semantic search services

Add this section only when Ollama and Milvus run locally or at endpoints you
control. Omit it to use the documented local defaults.

```yaml
services:
  ollama:
    url: http://127.0.0.1:11434
    embeddingModel: nomic-embed-text:v1.5
    answerModel: qwen3.5:9b
    queryExpansionModel: qwen3.5:9b
  milvus:
    address: 127.0.0.1:19530
```

### Optional handoff documents

Handoff documents are disabled by default because they live in user-level
storage. Enable them only when you want this project to index its own handoff
documents, and choose a project slug that is unique on your machine:

```yaml
sources:
  handoff:
    enabled: true
    projectSlug: example-project
```

Add every credential-bearing, generated, or third-party path to `exclude`
before indexing. The same policy is enforced by exact search, reads, indexing,
semantic evidence, and C# tracing. The indexer never writes project source
files.

`PROJECT_CONTEXT_MILVUS_TOKEN` enables authenticated Milvus access.
`PROJECT_CONTEXT_STATE_ROOT` and `PROJECT_CONTEXT_HANDOFF_ROOT` redirect local
state and handoff storage for tests or automation; typical installations do
not need them.

## CLI reference

| Command | Purpose |
| --- | --- |
| `project-context status [project-root]` | Check configuration, dependencies, and index freshness. |
| `project-context index <project-root> [--rebuild]` | Create or incrementally update the semantic index. |
| `project-context watch <project-root> [interval-ms]` | Keep an index current with filesystem events and safety scans. |
| `project-context search <project-root> <query> [mode] [scope] [max-results]` | Search in `auto`, `exact`, `graph`, or `semantic` mode. |
| `project-context trace <project-root> <symbol> <direction> [max-results]` | Trace C# `callers`, `callees`, `inherits`, or `implements`. |
| `project-context read <project-root> <path> [start-line] [end-line]` | Read an allowed, bounded file range. |
| `project-context ask <project-root> <question>` | Produce a local, source-cited development answer. |
| `project-context handoff save|update ...` | Create or update explicit handoff Markdown. |
| `project-context serve --mcp` | Start the stdio MCP server. |

## Development

```sh
git clone https://github.com/E-Hae/project-context.git
cd project-context
npm ci
npm run verify
npm pack --dry-run
```

`npm run verify` runs type checking, the full TypeScript suite, and the Roslyn
integration test. The package includes the built CLI and Roslyn worker; it does
not publish test fixtures, local evaluation data, or installed dependencies.

## License

Project Context MCP is [MIT licensed](LICENSE). See
[third-party notices](THIRD_PARTY_NOTICES.md) for bundled-worker and dependency
license details.
