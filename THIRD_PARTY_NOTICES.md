---
title: Third-Party Notices
date: 2026-07-23
tags: [licenses, dependencies]
---

# Third-Party Notices

The npm package includes the compiled Roslyn worker and its Microsoft
dependencies so C# tracing works after a normal install. JavaScript dependencies
are resolved by npm under their respective terms; their exact versions and
license metadata are recorded in `package-lock.json`.

## Runtime dependencies

| Dependency | License |
| --- | --- |
| `@modelcontextprotocol/sdk` | MIT |
| `minimatch` | Blue Oak Model License 1.0.0 |
| `yaml` | ISC |
| `zod` | MIT |
| `Microsoft.CodeAnalysis.CSharp` and its transitive Microsoft packages | MIT (bundled in the Roslyn worker) |

## Development dependencies

| Dependency | License |
| --- | --- |
| `@types/node` | MIT |
| `typescript` | Apache-2.0 |

The bundled Microsoft Roslyn worker contains `Microsoft.CodeAnalysis.CSharp`,
`Microsoft.CodeAnalysis.Common`, `Microsoft.CodeAnalysis.Analyzers`,
`System.Collections.Immutable`, and `System.Reflection.Metadata`.

Copyright © Microsoft Corporation. All rights reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
