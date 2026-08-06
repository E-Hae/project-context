# Changelog

All notable changes to Project Context MCP are documented in this file.

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
