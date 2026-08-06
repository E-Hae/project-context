# Project Context MCP

[![npm version](https://img.shields.io/npm/v/project-context-mcp.svg)](https://www.npmjs.com/package/project-context-mcp)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js 20+](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)](https://nodejs.org/)

`project-context-mcp` is an evidence-first local MCP server and CLI for navigating
codebases. It performs deterministic status checks, exact and semantic search,
source-grounded GraphRAG, bounded source reads, optional source-backed tracing
adapters, and explicit handoff access.

It is designed to keep source evidence local: the tool talks only to the local
or self-hosted services you configure. Search results include source paths and
line ranges so an agent or developer can verify the underlying code.

## Features

| Capability | What it does |
| --- | --- |
| Exact search | Fast, deterministic `rg` search with configured source and exclusion rules. |
| Semantic search | Project-isolated embeddings in a persistent local vector store by default, validated against current file hashes. |
| GraphRAG | `auto` code search expands verified vector seeds through a bounded, persisted source graph and can attach a source-citable project-to-directory hierarchy. |
| Graph tracing | Optional language adapters return source-backed callers, callees, inheritance, and implementation relationships. |
| Bounded reads | Reads only configured project files and returns a limited source range. |
| Handoffs | Lists, reads, creates, and updates explicit Markdown handoff documents safely. |

## Quick start

Install the CLI globally:

```sh
npm install --global project-context-mcp
pctx --help
pctx --version # core and installed adapter versions
```

`pctx` is the short CLI alias. `project-context-mcp` remains available as the
fully qualified command.

To enable C# tracing, install the optional C# adapter alongside the core:

```sh
npm install --global project-context-mcp-csharp
```

To enable TypeScript and JavaScript tracing, install the optional TypeScript
adapter:

```sh
npm install --global project-context-mcp-typescript
```

Unity projects can add asset-graph tracing, and repositories with Git history
can add change-impact analysis:

```sh
npm install --global project-context-mcp-unity
npm install --global project-context-mcp-git
```

Then add a `.project-context/config.yml` file to the project you want
to inspect and run a status check:

```sh
pctx status /path/to/project
pctx index /path/to/project
pctx search /path/to/project "session restore" auto code 10
pctx update
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
`context_trace`, `context_impact`, and the `context_handoff_*` tools. Start with
`context_status` to confirm the selected project and local dependencies.

## Requirements

- Node.js 20 or newer
- `rg` (ripgrep) for exact search
- An Ollama embedding model configured for semantic search

The core package runs status, exact search, and semantic search without .NET,
TypeScript, or a language adapter. C# tracing additionally requires .NET 8 and
the `project-context-mcp-csharp` adapter package. TypeScript and JavaScript
tracing uses the TypeScript compiler bundled by the
`project-context-mcp-typescript` adapter.

Semantic search requires an Ollama embedding model, but uses a persistent local
vector store by default and does not require Milvus. Exact search, bounded
reads, status checks, and handoff access do not require Ollama or Milvus.
`context_trace` does not require either service.

After upgrading to 2.5.0 or later, run `pctx index <project-root>` once to
create the source-graph snapshot. Until a compatible adapter produces a fresh
snapshot, `auto` search remains available and uses the existing semantic path.

## Trace adapters

`context_trace` and `project-context-mcp trace` use an installed trace adapter.
The core discovers the default C# and TypeScript candidates and any
comma-separated package names in `PROJECT_CONTEXT_TRACE_ADAPTERS`. It selects
the single adapter whose source extensions match the project, or requires
`language` when several match. It never scans `node_modules` or installs
packages automatically.

The TypeScript adapter is named `project-context-mcp-typescript` and handles
TypeScript and JavaScript source files. Its canonical language is `typescript`,
with `javascript` and `js` accepted as language aliases. JavaScript analysis
enables `allowJs` for the requested JavaScript sources and respects the
project's `checkJs` and JSDoc settings; dynamic runtime dispatch can produce
partial results.

Without a compatible adapter, an explicit trace reports an installation hint.
Automatic graph routing falls back to semantic search when the symbol is absent
or tracing is unavailable. Adapter ambiguity stays visible instead of being
silently replaced by semantic results. Graph search first infers an adapter from
a concrete target path and then, when needed, from exact-search result
extensions. Pass an optional language after `max-results` to the CLI search or
trace command, or the optional `language` field to `context_search` or
`context_trace`.

During indexing, adapters that expose a whole-project graph builder create a
separate language shard. The core currently includes builders for TypeScript and
JavaScript, C# via Roslyn, and Unity assets. The shard is tied to the same
commit and vector collection as the semantic index; GraphRAG checks current file
hashes again before returning an expanded symbol. Trace-only third-party
adapters remain compatible and simply do not contribute a GraphRAG shard.

When graph data is available, indexing also builds an immutable hierarchy
sidecar from project, configured code-root, and directory modules. It contains
only node, edge, and source locators; no LLM-generated summary text or source
excerpts are stored. `auto` search returns optional `graph.summaries` only when
the hierarchy fingerprint, index identity, commit, graph checksum, and current
source hashes all still match. Missing, stale, or invalid hierarchy data is
silently omitted while ordinary semantic and graph-backed evidence remains
available. Reindex after upgrading to refresh graph and hierarchy snapshots.

The Unity adapter is named `project-context-mcp-unity`. Its YAML mode follows
prefab, scene, ScriptableObject, `.meta` GUID, `.asmdef`, and `.asmref` links.
Add Unity `Assets` paths to `sources.code`, then use `unity` as the trace
language when another adapter also matches the project.

## Project configuration

Configuration is optional. Create `.project-context/config.yml` in the
target project when you want to narrow the indexed sources or add project-specific
exclusions. The example below contains only project-owned paths; it does not
include a user home directory, account, token, or machine-specific setting.

```yaml
version: 1
sources:
  code: [src]
  documents: [README.md, docs]
  semanticExclude:
    - "src/**/Generated/**"
exclude:
  - node_modules/**
  - .git/**
  - "**/*.dll"
  - "**/*.keystore"
```

### Graph-only semantic exclusions

Use `sources.semanticExclude` for glob patterns that graph tracing should still
read but semantic search must not embed. The paths must already be covered by
`sources.code`; matching document paths are unaffected. This setting only
removes them from the vector index and also removes any vectors that a previous
indexing run created for them.

```yaml
sources:
  code: [src]
  semanticExclude:
    - "src/Generated/**"
    - "src/**/*.g.cs"
```

Exact search and `context_read` retain their existing source policy. Add a path
to the top-level `exclude` list instead when it must be unavailable to every
search and read route, including graph tracing.

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

### Unity batch mode

YAML analysis requires no Unity installation. For importer-aware dependencies,
configure a Unity Hub Editor version and batch mode:

```yaml
adapters:
  unity:
    mode: batch
    editorVersion: 6000.0.32f1
    batchTimeoutSeconds: 180
```

The adapter resolves standard Unity Hub locations for the selected version.
Set `PROJECT_CONTEXT_UNITY_EDITOR` to override the executable path for one
machine. Batch mode requires the bundled `com.project-context.asset-graph` UPM
bridge: install the `bridge` directory included in the Unity adapter package as
a local Unity package. It calls `AssetDatabase.GetDependencies` and returns a
temporary JSON result outside the project; Unity may still update its regular
`Library` cache while it runs.

### Git change impact

The Git adapter is an impact operation, not a symbol trace. It ranks files that
changed in the same commits as a target file:

```sh
pctx impact . src/npm-updater.ts 20 git
```

Tune the bounded history window per project when needed:

```yaml
adapters:
  git:
    historyLimit: 500
```

## CLI reference

| Command | Purpose |
| --- | --- |
| `pctx status [project-root]` | Check configuration, dependencies, and index freshness. |
| `pctx index <project-root> [--rebuild]` | Create or incrementally update the semantic index and available source-graph snapshots. |
| `pctx watch <project-root> [interval-ms]` | Keep an index current with filesystem events and safety scans. |
| `pctx search <project-root> <query> [mode] [scope] [max-results] [language]` | Search in `auto`, `exact`, `graph`, or `semantic` mode. `auto` uses GraphRAG for natural-language code queries when a fresh graph snapshot is available. |
| `pctx trace <project-root> <symbol> <direction> [max-results] [language]` | Trace relationships with an installed language adapter. |
| `pctx impact <project-root> <path> [max-results] [language]` | Rank files that historically change with a project file. |
| `pctx read <project-root> <path> [start-line] [end-line]` | Read an allowed, bounded file range. |
| `pctx handoff save|update ...` | Create or update explicit handoff Markdown. |
| `pctx update` | Update the global core and any installed trace or impact adapters to their latest releases. |
| `pctx serve --mcp` | Start the stdio MCP server. |

## Development

```sh
git clone https://github.com/E-Hae/project-context.git
cd project-context
npm ci
npm run verify
npm --workspace adapters/csharp run verify
npm --workspace adapters/typescript run verify
npm pack --dry-run
```

`npm run verify` verifies the language-neutral core without .NET. The C# adapter
builds and verifies its Roslyn worker separately. The core tarball includes
JavaScript dependency notices but excludes workers and Microsoft binaries; the
C# adapter tarball includes its worker and Microsoft third-party notices.

## Migration to 2.0.0

The `ask` CLI command and `services.ollama.answerModel` setting were removed.
Use an MCP client with `context_search`, `context_read`, and `context_trace` to
compose answers, and remove `answerModel` from existing project configuration.

## License

Project Context MCP is [MIT licensed](LICENSE). Core JavaScript dependency
notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md); the optional
C# adapter carries the notices for its bundled Microsoft worker dependencies.
