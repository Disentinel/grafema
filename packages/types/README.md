# @grafema/types

> Type definitions for Grafema code analysis toolkit

**Warning: This package is in early alpha stage and is not recommended for production use.**

## Installation

```bash
npm install @grafema/types
```

## Overview

This package provides TypeScript type definitions used across the Grafema ecosystem:

- **Node types** - Graph node definitions (functions, classes, variables, etc.)
- **Edge types** - Relationship definitions (calls, imports, assignments, etc.)
- **Plugin types** - Plugin system interfaces
- **RFDB types** - Wire protocol types for RFDB graph database

## Usage

```typescript
import type { NodeType, EdgeType, WireNode, WireEdge } from '@grafema/types';
```

## Exports

| Module | Description |
|--------|-------------|
| `nodes` | Node type definitions |
| `edges` | Edge type definitions |
| `plugins` | Plugin interface types |
| `rfdb` | RFDB protocol types |

## License

Apache-2.0
