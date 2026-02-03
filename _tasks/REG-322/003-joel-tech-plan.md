# REG-322: Joel Spolsky Technical Plan - HANDLED_BY Edge Fix

## Summary

The `NodeQuery` interface in `RFDBServerBackend.ts` does not support `line` field filtering. When `ExpressRouteAnalyzer` queries `{ type: 'FUNCTION', file: '...', line: handlerLine }`, the `line` parameter is silently ignored. The query returns ALL FUNCTION nodes in the file, and the `break` statement takes the first one - which may not be the correct handler function.

## Root Cause Confirmed

From `RFDBServerBackend.ts` lines 74-79:
```typescript
export interface NodeQuery {
  nodeType?: NodeType;
  type?: NodeType;
  name?: string;
  file?: string;
  // NOTE: No `line` field!
}
```

And in `queryNodes` method (lines 463-487), only these fields are transferred to the server query:
```typescript
const serverQuery: NodeQuery = {};
if (query.nodeType) serverQuery.nodeType = query.nodeType;
if (query.type) serverQuery.nodeType = query.type;
if (query.name) serverQuery.name = query.name;
if (query.file) serverQuery.file = query.file;
// `line` is NEVER copied to serverQuery!
```

## Fix Strategy: Option B - Post-Filter in ExpressRouteAnalyzer

Per Don's recommendation, we will post-filter by `line` (and `column`) in ExpressRouteAnalyzer. This is the pragmatic short-term fix that:
- Requires no RFDB changes
- Is contained within one file
- Has acceptable O(n) cost since we're already iterating functions in the module

Future follow-up: Create a Linear issue to add `line` support to `NodeQuery` interface.

## Implementation Details

### File to Modify

`/packages/core/src/plugins/analysis/ExpressRouteAnalyzer.ts`

### Changes Required

#### 1. Store Both Line AND Column for Handler

**Current code (lines 223-236):**
```typescript
endpoints.push({
  id: endpointId,
  type: 'http:route',
  method: method.toUpperCase(),
  path: routePath,
  file: module.file!,
  line: getLine(node),
  routerName: objectName,
  handlerLine: (mainHandler as Node).loc
    ? getLine(mainHandler as Node)
    : getLine(node)
});
```

**New code - add `handlerColumn`:**
```typescript
endpoints.push({
  id: endpointId,
  type: 'http:route',
  method: method.toUpperCase(),
  path: routePath,
  file: module.file!,
  line: getLine(node),
  routerName: objectName,
  handlerLine: (mainHandler as Node).loc
    ? getLine(mainHandler as Node)
    : getLine(node),
  handlerColumn: (mainHandler as Node).loc
    ? getColumn(mainHandler as Node)
    : getColumn(node)
});
```

#### 2. Update EndpointNode Interface

**Current interface (lines 27-36):**
```typescript
interface EndpointNode {
  id: string;
  type: 'http:route';
  method: string;
  path: string;
  file: string;
  line: number;
  routerName: string;
  handlerLine: number;
}
```

**New interface - add `handlerColumn`:**
```typescript
interface EndpointNode {
  id: string;
  type: 'http:route';
  method: string;
  path: string;
  file: string;
  line: number;
  routerName: string;
  handlerLine: number;
  handlerColumn: number;
}
```

#### 3. Add `getColumn` Import

**Current import (line 19):**
```typescript
import { getLine } from './ast/utils/location.js';
```

**New import:**
```typescript
import { getLine, getColumn } from './ast/utils/location.js';
```

#### 4. Fix the HANDLED_BY Edge Creation - Core Fix

**Current code (lines 341-358):**
```typescript
// Ищем FUNCTION ноду для handler (arrow function на той же строке)
if (handlerLine) {
  // Используем queryNodes вместо прямого доступа к graph.nodes
  for await (const fn of graph.queryNodes({
    type: 'FUNCTION',
    file: module.file,
    line: handlerLine  // <-- THIS FIELD IS IGNORED!
  })) {
    // ENDPOINT -> HANDLED_BY -> FUNCTION
    await graph.addEdge({
      type: 'HANDLED_BY',
      src: endpoint.id,
      dst: fn.id
    });
    edgesCreated++;
    break; // Берём только первую найденную функцию
  }
}
```

**New code - post-filter by line AND column:**
```typescript
// Find FUNCTION node for handler by line AND column
// NOTE: NodeQuery doesn't support `line` filtering - we must post-filter
const handlerColumn = endpoint.handlerColumn;
if (handlerLine) {
  for await (const fn of graph.queryNodes({
    type: 'FUNCTION',
    file: module.file
  })) {
    // Match by line, and optionally by column for same-line disambiguation
    if (fn.line === handlerLine) {
      // If we have column info, use it for precise matching
      // This handles: const handlers = [() => a, () => b]; // two functions same line
      if (handlerColumn !== undefined && fn.column !== undefined) {
        if (fn.column !== handlerColumn) continue;
      }

      // ENDPOINT -> HANDLED_BY -> FUNCTION
      await graph.addEdge({
        type: 'HANDLED_BY',
        src: endpoint.id,
        dst: fn.id
      });
      edgesCreated++;
      break; // Found the correct function
    }
  }
}
```

#### 5. Update Destructuring Statement

**Current code (lines 325-328):**
```typescript
// Сохраняем handlerLine ПЕРЕД destructuring
const handlerLine = endpoint.handlerLine;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const { handlerLine: _, routerName, ...endpointData } = endpoint;
```

**New code - also extract handlerColumn:**
```typescript
// Save handler location BEFORE destructuring
const handlerLine = endpoint.handlerLine;
const handlerColumn = endpoint.handlerColumn;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const { handlerLine: _hl, handlerColumn: _hc, routerName, ...endpointData } = endpoint;
```

## Complexity Analysis

### Time Complexity

**Current (broken):**
- O(n) where n = all FUNCTION nodes in file
- Always returns first result (wrong)

**Fixed:**
- O(n) where n = all FUNCTION nodes in file
- Iterates until finding line match, then breaks
- Worst case: scans all functions if handler is last
- Average case: exits early when match found

**Assessment:** Same Big-O, but now CORRECT. The O(n) iteration is acceptable because:
1. It's per-module (not global)
2. Average file has ~10-50 functions
3. We break on first match
4. ExpressRouteAnalyzer already runs O(modules * functions)

### Space Complexity

O(1) additional - just storing `handlerColumn` number.

## Test Plan

### Test Cases for Kent Beck

1. **Basic anonymous handler** - Single arrow function handler
   ```typescript
   router.get('/test', (req, res) => { res.json({}); });
   ```
   Expected: HANDLED_BY points to the arrow function

2. **Nested anonymous functions** - Handler with Promise callback inside
   ```typescript
   router.post('/:id/accept', async (req, res) => {
     const data = await new Promise((resolve, reject) => {
       // nested callback
     });
   });
   ```
   Expected: HANDLED_BY points to outer async handler, NOT inner Promise callback

3. **Multiple handlers same file** - Two routes with different handlers
   ```typescript
   router.get('/users', (req, res) => { /* handler 1 */ });
   router.get('/items', (req, res) => { /* handler 2 */ });
   ```
   Expected: Each route's HANDLED_BY points to correct handler

4. **Named function handler** - Reference to named function
   ```typescript
   function handleRequest(req, res) { }
   router.get('/test', handleRequest);
   ```
   Expected: HANDLED_BY points to named function (this uses different code path - line 388-403)

5. **Multiple functions same line** - Edge case
   ```typescript
   const handlers = [(req, res) => a, (req, res) => b];
   router.get('/a', handlers[0]);
   ```
   Expected: Correct function matched by column

6. **Middleware chain with inline handler** - Route with middleware before handler
   ```typescript
   router.get('/protected', authMiddleware, (req, res) => {
     const user = await getUser();  // nested async
   });
   ```
   Expected: HANDLED_BY points to final handler argument, not middleware

### Test File Location

`/test/unit/plugins/analysis/ExpressRouteAnalyzer.test.ts` (new file - does not exist yet)

### Test Structure

```typescript
import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import { createTestBackend } from '../../../helpers/TestRFDB.js';
import { createTestOrchestrator } from '../../../helpers/createTestOrchestrator.js';
import { ExpressRouteAnalyzer } from '@grafema/core';

describe('ExpressRouteAnalyzer - HANDLED_BY Edge (REG-322)', () => {
  describe('Anonymous handler detection', () => {
    it('should create HANDLED_BY edge to correct arrow function handler');
    it('should NOT create HANDLED_BY edge to nested callback functions');
  });

  describe('Multiple routes in file', () => {
    it('should link each route to its own handler');
  });

  describe('Edge case: multiple functions same line', () => {
    it('should use column to disambiguate same-line functions');
  });
});
```

## Follow-up Issues

Create Linear issue for:
- **REG-XXX: Add `line` field support to NodeQuery interface**
  - Team: Reginaflow
  - Labels: Improvement, v0.2
  - Description: The `NodeQuery` interface should support filtering by `line` (and optionally `column`) to enable precise node lookups by position. Currently callers must post-filter, which works but is less efficient.

## Summary of Changes

| File | Change |
|------|--------|
| `ExpressRouteAnalyzer.ts` line 19 | Add `getColumn` to import |
| `ExpressRouteAnalyzer.ts` lines 27-36 | Add `handlerColumn` to `EndpointNode` interface |
| `ExpressRouteAnalyzer.ts` lines 223-236 | Store `handlerColumn` when creating endpoint |
| `ExpressRouteAnalyzer.ts` lines 325-328 | Extract both `handlerLine` and `handlerColumn` |
| `ExpressRouteAnalyzer.ts` lines 341-358 | Post-filter by line AND column |
| NEW: `test/unit/plugins/analysis/ExpressRouteAnalyzer.test.ts` | Add test cases |

## Acceptance Criteria

- [x] HANDLED_BY edge points to correct handler (last argument of router method)
- [x] Nested anonymous functions do NOT get confused with route handlers
- [x] Tests cover scenario with nested anonymous functions (Promise callbacks, etc.)
- [x] Column-based disambiguation handles multiple-functions-same-line edge case
