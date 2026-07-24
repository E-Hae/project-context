# Project Context MCP

[![npm version](https://img.shields.io/npm/v/project-context-mcp.svg)](https://www.npmjs.com/package/project-context-mcp)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js 20+](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)](https://nodejs.org/)

`project-context-mcp` is an evidence-first local MCP server and CLI for navigating
codebases. It performs deterministic status checks, exact and semantic search,
bounded source reads, optional source-backed tracing adapters, and explicit
handoff access.

It is designed to keep source evidence local: the tool talks only to the local
or self-hosted services you configure. Search results include source paths and
line ranges so an agent or developer can verify the underlying code.

## Features

| Capability | What it does |
| --- | --- |
| Exact search | Fast, deterministic `rg` search with configured source and exclusion rules. |
| Semantic search | Project-isolated embeddings in a persistent local vector store by default, validated against current file hashes. |
| Graph tracing | Optional language adapters return source-backed callers, callees, inheritance, and implementation relationships. |
| Bounded reads | Reads only configured project files and returns a limited source range. |
| Handoffs | Lists, reads, creates, and updates explicit Markdown handoff documents safely. |

## Quick start

Install the CLI globally:

```sh
npm install --global project-context-mcp
pctx --help
```

`pctx` is the short CLI alias. `project-context-mcp` remains available as the
fully qualified command.

To enable C# tracing, install the optional C# adapter alongside the core:

```sh
npm install --global project-context-mcp-csharp
```

Then add a `.project-context.yml` file to the project you want to inspect and
run a status check:

```sh
pctx status /path/to/project
pctx index /path/to/project
pctx search /path/to/project "session restore" auto code 10
```

On Windows, quote paths that contain spaces:

```powershell
pctx status 'C:\work\my project'
```

### Connect an MCP client

Add this standard MCP server entry to your client's configuration:

```json
{
  "mcpServers": {
    "project-context-mcp": {
      "command": "project-context-mcp",
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
- An Ollama embedding model configured for semantic search
- An Ollama answer model for `ask`

The core package runs status, exact search, semantic search, and `ask` without
.NET or a language adapter. C# tracing additionally requires .NET 8 and the
`project-context-mcp-csharp` adapter package.

Semantic search requires an Ollama embedding model, but uses a persistent local
vector store by default and does not require Milvus. Exact search, bounded
reads, status checks, and handoff access do not require Ollama or Milvus.
`context_trace` does not require either service.

## Trace adapters

`context_trace` and `project-context-mcp trace` use an installed trace adapter.
The core discovers the built-in C# candidate and any comma-separated package
names in `PROJECT_CONTEXT_TRACE_ADAPTERS`. It selects the single adapter whose
source extensions match the project, or requires `language` when several match.
It never scans `node_modules` or installs packages automatically.

Without a compatible adapter, an explicit trace reports an installation hint.
Automatic graph routing falls back to semantic search when tracing is unavailable
or ambiguous. Pass an optional language after `max-results` to the CLI trace
command, or the optional `language` field to `context_trace`.

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

### Semantic search services

Semantic search needs an Ollama embedding model that you operate and configure
for the project. The vector store is local and persistent by default, so no
Milvus service is needed.

```yaml
services:
  ollama:
    embeddingModel: <installed-embedding-model>
```

### Milvus opt-in

Use Milvus only when you explicitly select it. Configure the address for the
Milvus service you operate:

```yaml
services:
  vectorStore:
    backend: milvus
  milvus:
    address: <milvus-address>
```

For legacy compatibility, a configuration that contains `services.milvus` but
does not set `services.vectorStore.backend` continues to select Milvus. When
both are present, the explicit `services.vectorStore.backend` value wins.

Switching vector-store backends requires reindexing. Existing data in the old
backend is not deleted or migrated automatically.

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
| `project-context-mcp status [project-root]` | Check configuration, dependencies, and index freshness. |
| `project-context-mcp index <project-root> [--rebuild]` | Create or incrementally update the semantic index. |
| `project-context-mcp watch <project-root> [interval-ms]` | Keep an index current with filesystem events and safety scans. |
| `project-context-mcp search <project-root> <query> [mode] [scope] [max-results]` | Search in `auto`, `exact`, `graph`, or `semantic` mode. |
| `project-context-mcp trace <project-root> <symbol> <direction> [max-results] [language]` | Trace relationships with an installed language adapter. |
| `project-context-mcp read <project-root> <path> [start-line] [end-line]` | Read an allowed, bounded file range. |
| `project-context-mcp ask <project-root> <question>` | Produce a local, source-cited development answer. |
| `project-context-mcp handoff save|update ...` | Create or update explicit handoff Markdown. |
| `project-context-mcp serve --mcp` | Start the stdio MCP server. |

## Development

```sh
git clone https://github.com/E-Hae/project-context.git
cd project-context
npm ci
npm run verify
npm --workspace adapters/csharp run verify
npm pack --dry-run
```

`npm run verify` verifies the language-neutral core without .NET. The C# adapter
builds and verifies its Roslyn worker separately. The core tarball includes
JavaScript dependency notices but excludes workers and Microsoft binaries; the
C# adapter tarball includes its worker and Microsoft third-party notices.

## Migration from 0.3.x

Upgrade the core to `project-context-mcp@1.0.3`. If you used C# tracing in
0.3.x, install `project-context-mcp-csharp@1.0.0` and ensure .NET 8 is
available. No project configuration change is required for the existing C#
trace command. Core-only installations remain fully supported; only graph
tracing becomes optional.

## License

Project Context MCP is [MIT licensed](LICENSE). Core JavaScript dependency
notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md); the optional
C# adapter carries the notices for its bundled Microsoft worker dependencies.
