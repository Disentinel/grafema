# REG-445: Grafema CLI — packages/types not analyzed, type symbols not extracted

## Context

Found during REG-368 dogfooding. Grafema CLI was completely unable to help with exploring `@grafema/types` package.

## Problem

4 out of 4 CLI queries failed:

| Query | Command | Result |
| -- | -- | -- |
| Find brandNode definition | `query "brandNode"` | No results |
| Find AnyBrandedNode | `query "AnyBrandedNode"` | No results |
| Find GraphBackend | `query "GraphBackend"` | No results |
| Check @grafema/types exports | `file "packages/types/src/index.ts"` | NOT_ANALYZED |

## Root Cause

1. **packages/types not analyzed** — entry point limitation means the types package isn't discovered
2. **Type symbols not extracted** — TypeScript interfaces, type aliases, and exported functions from type-only packages aren't indexed as nodes

## Impact

Any task involving type system changes (branded nodes, interfaces, contracts) gets zero value from Grafema. Must fall back to Grep/Read for everything.

## Suggested Fix

* Ensure all workspace packages are analyzed (not just entry-point-discovered ones)
* Extract TYPE_ALIAS and INTERFACE nodes from TypeScript sources
* Index exported functions even in type-only packages
