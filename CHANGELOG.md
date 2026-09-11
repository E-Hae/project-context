# Changelog

All notable changes to Project Context MCP are documented in this file.

## 2.7.0 - 2026-09-11

Released together with `project-context-mcp-csharp`, `project-context-mcp-typescript`, and `project-context-mcp-unity` 1.2.0, which require this core version.

### Added

- Added the `derived` and `implementedBy` trace directions, which return the types that inherit a class or implement an interface. The C# and TypeScript adapters support them.
- Trace adapters can declare `supportedDirections`. The core rejects any other direction with `unsupported_direction` instead of sending it; an adapter without the field keeps the original four directions.
- The C# adapter names the symbols that unresolved references use in `diagnostics.metadata.missingNames` and suggests `sources.semanticExclude` when those declarations were excluded (Roslyn worker 0.4.0).

### Changed

- `graph.summaries` in `auto` search is now compact: at most `maxResults` reached modules plus their ancestors, each with node and edge counts and up to three node locators, capped at 16 KiB. Locators no longer carry hashes or graph ids, and the `sources` lists and `staleSourcesSkipped` count are gone, so clients that read those fields need updating. For a six-result query on this repository, the summaries shrank from 229,370 to 3,419 characters.
- A search whose GraphRAG expansion ran reports `route: "graphrag"` instead of `"semantic"`; clients that match on `route` need updating.
- Exact search no longer passes `--sort path` to ripgrep, which made ripgrep search single-threaded. It lists matching files in parallel, orders them the way the sorted search did, and reads line evidence from the first files only, so result order and truncation stay the same. In a 12,000-file test, a rare-string search took 0.26 s instead of 1.07 s with a warm cache, and 3.3 s cold where the sorted search exceeded the 15 s timeout. A frequent string now costs a full parallel scan instead of stopping early, and one unreadable file no longer fails a search that found other matches.
- Semantic search applies `scope` inside the vector query for both the local store and Milvus, so code chunks can no longer crowd documents out of a `documents` search.
- An explicit trace `language` selects that adapter even when the target's file type is not one of its sources. When the project has no files for that adapter, the trace reports `adapter_unavailable`, so `auto` search still falls back.
- The C# adapter reports a worker that rejects a direction, as a 0.3.0 worker does for `derived`, as unavailable.
- The Unity adapter traces a script, texture, or model through its `.meta` file, and returns one result per referencing asset and target with `metadata.occurrences` and `metadata.lines` for repeated references.
- The Unity adapter declares only `callers` and `callees`; `inherits` and `implements` previously returned callers.

### Fixed

- Graph search reads Korean particles against the traced symbol. `X를 호출하는 곳`, `X 어디서 호출돼?`, `X 호출하는 메서드`, `누가 X 호출해?`, `X 사용처`, and `X를 부르는 곳` now ask for callers instead of callees, and a long asset path no longer hides the reference verb.
- `X를 상속하는 클래스` and `IFeature 구현 타입` now ask for `derived` and `implementedBy` instead of the base types of X.
- An empty graph search result names the directions to try instead in its first diagnostics message.
- Graph search no longer takes the first word of an English question, such as `Who` or `What`, as the traced symbol.
- An unaccepted target file type now reports which installed adapters exist instead of claiming that no adapter is installed.

## 2.6.0 - 2026-09-10

### Added

- Added `index.reuseMainWorktree`, which lets a linked git worktree read the semantic and graph index that belongs to the main worktree instead of building its own.
- `pctx status` now reports the tree an index belongs to as `index.indexRoot` and measures index freshness against that tree's commit.
- A linked git worktree with no `.project-context/config.yml` of its own now inherits the main worktree's configuration instead of falling back to defaults. A worktree that has its own file keeps it.

### Changed

- `pctx index` and `pctx watch` refuse to run inside a worktree that reuses the main worktree index. They name the main worktree instead of replacing the shared collection with branch content.
- Handoff documents now resolve a linked worktree's main project through Git instead of matching a `.worktrees/` path segment, so any worktree layout resolves the same handoffs.
- The published package no longer contains JavaScript source maps. They pointed at TypeScript sources the package never shipped and accounted for nearly half of its unpacked size.

### Fixed

- Handoff documents no longer fail to resolve from a worktree that is not placed directly under `<main>/.worktrees/`, such as `<main>/.claude/.worktrees/<name>`.
- `pctx status` no longer reports a registered handoff project as missing while a session works inside a linked worktree.
- The MCP server reports the installed package version to clients instead of a hardcoded `0.1.0`.

## 2.5.1 - 2026-08-26

### Fixed

- Normalize persisted graph and hierarchy project roots before freshness checks, preventing equivalent Windows path spellings from making newly indexed snapshots appear stale.

## 2.5.0 - 2026-08-05

### Added

- Added a deterministic project-to-directory hierarchy sidecar for GraphRAG. It contains only source, node, and edge locators—never generated prose or source excerpts.
- Added immutable hierarchy payloads tied to the semantic index, graph manifest fingerprint, commit, and current source hashes before optional `graph.summaries` evidence is returned.
- Added source-grounded GraphRAG to `auto` code search: verified vector evidence seeds a bounded two-hop expansion over a persisted source graph.
- Added project-local graph manifests with separate bounded language shards, keeping graph data outside the vector index state file.
- Added whole-project graph builders to the TypeScript/JavaScript, C# Roslyn, and Unity asset adapters.

### Changed

- Graph shards now carry content checksums, and hierarchy snapshots are bounded and pruned deterministically when necessary.
- GraphRAG preserves semantic result limits on every fallback and can return verified seed hierarchy even when the source graph has no edges.
- `pctx index` now refreshes graph snapshots alongside the vector index. A project without a usable graph snapshot continues to use semantic search automatically.
- GraphRAG re-reads every expanded source node and drops changed or excluded evidence before it is returned.

## 2.4.0 - 2026-07-28

### Added

- Added an optional graph-adapter `language` argument to `context_search` in the MCP server and CLI.
- Added adapter inference from concrete source and Unity asset paths.
- Added one bounded exact-search retry that uses evidence file extensions to resolve graph-adapter ambiguity.

### Changed

- Automatic graph routing now preserves unresolved adapter ambiguity instead of silently returning semantic-search results.
- Successful graph search is documented as both the mandatory search result and the adapter trace, avoiding duplicate trace calls.

### Fixed

- Recognize Unity asset paths and bare source or asset filenames as graph targets.
- Distinguish incoming reference questions from outgoing dependency questions in English and Korean routing.
- Update `@modelcontextprotocol/sdk` to 1.30.0 to include its patched Hono server dependency.
