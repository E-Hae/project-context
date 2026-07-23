---
title: Third-Party Notices
date: 2026-07-23
tags: [licenses, dependencies]
---

# Third-Party Notices

This repository does not include third-party dependency source or compiled
binaries. Installing the project resolves the exact dependency versions in
`package-lock.json` and the NuGet restore graph under their respective terms.

## Runtime dependencies

| Dependency | License |
| --- | --- |
| `@modelcontextprotocol/sdk` | MIT |
| `minimatch` | Blue Oak Model License 1.0.0 |
| `yaml` | ISC |
| `zod` | MIT |
| `Microsoft.CodeAnalysis.CSharp` and its transitive Microsoft packages | MIT |

## Development dependencies

| Dependency | License |
| --- | --- |
| `@types/node` | MIT |
| `typescript` | Apache-2.0 |

The lockfile also records license metadata for every resolved npm transitive
dependency. Keep this notice and the lockfile when redistributing the project.
