# User Request: REG-192

## Linear Issue

**REG-192: Type safety: Properly type RFDB query results**

## Problem

The `(node as any)` pattern appears throughout CLI commands when working with RFDB query results. This loses type safety and hides potential issues.

Example from `trace.ts`:

```typescript
const name = (node as any).name || '';
const file = (node as any).file || '';
const line = (node as any).line;
```

## Root Cause

The `queryNodes` return type from RFDB backend doesn't match the expected node structure.

## Proposed Solution

Define proper interface for RFDB nodes:

```typescript
interface RFDBNode {
  id: string;
  nodeType: string;
  name?: string;
  type?: string;
  file?: string;
  line?: number;
  value?: unknown;
  [key: string]: unknown; // for plugin-added properties
}
```

## Acceptance Criteria

1. `backend.queryNodes()` returns properly typed nodes
2. No `as any` casting needed in CLI commands
3. TypeScript catches errors if node structure changes

## Context

Noted during REG-187 code review by Kevlin Henney.
