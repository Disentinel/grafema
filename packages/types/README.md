# @grafema/types

> Type definitions for Grafema code analysis toolkit

**Warning: This package is in beta stage and the API may change between minor versions.**

## Installation

```bash
npm install @grafema/types
```

## Overview

This package provides TypeScript type definitions used across the Grafema ecosystem:

- **Node types** — Graph node definitions (functions, variables, calls, parameters, etc.)
- **Edge types** — Relationship definitions (CALLS, IMPORTS, ASSIGNED_FROM, FLOWS_INTO, etc.)
- **Plugin types** — Plugin system interfaces (phases, metadata, context)
- **RFDB types** — Wire protocol types for RFDB graph database
- **Infrastructure types** — USG (Unified Service Graph) types for infrastructure-as-code analysis

## Usage

```typescript
import type { NodeType, EdgeType, WireNode, WireEdge } from '@grafema/types';
import type { PluginMetadata, PluginPhase } from '@grafema/types';
import type { InfraNodeType, InfraEdgeType } from '@grafema/types';
```

## Exports

| Module | Description |
|--------|-------------|
| `nodes` | Node type definitions (FUNCTION, VARIABLE, CALL, MODULE, etc.) |
| `edges` | Edge type definitions (CALLS, IMPORTS, ASSIGNED_FROM, etc.) |
| `plugins` | Plugin interface types and phase definitions |
| `rfdb` | RFDB wire protocol types |
| `infra` | USG infrastructure types (Kubernetes, Terraform, Docker) |

## License

Apache-2.0
