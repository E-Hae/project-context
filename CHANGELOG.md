# Changelog

All notable changes to Project Context MCP are documented in this file.

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
