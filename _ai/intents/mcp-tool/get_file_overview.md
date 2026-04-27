---
whenToUse: |
  "What's in this file?" Returns every entity the file contains:
  classes, functions, exports, imports, top-level constants, plus
  line numbers. Use as the file-level entry point — read this first
  before diving into specific function definitions.
seeAlso:
  - mcp:tool:find_nodes
  - mcp:tool:describe
  - cli:command:tldr
  - cli:command:file
gotchas:
  - For very large files (>200 entities) the response paginates
    via `limit` + `offset`. Default returns top 50.
---

## Overview of a source file

```json
{ "file": "packages/cli/src/cli.ts" }
```
