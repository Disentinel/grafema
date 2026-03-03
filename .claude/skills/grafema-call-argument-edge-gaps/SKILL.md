---
name: grafema-call-argument-edge-gaps
description: |
  Debug missing PASSES_ARGUMENT (or other argument-tracing) edges on CALL nodes in Grafema
  when the ArgumentExtractor infrastructure exists but is not called at all CALL node creation sites.
  Use when: (1) PASSES_ARGUMENT edges exist for method calls but not direct calls or new expressions,
  (2) some CALL node types have argument edges but others don't, (3) adding a new argument-related
  edge type and wondering which files to touch. Root cause: ArgumentExtractor.extract() must be
  called explicitly at EACH of 5 CALL node creation sites — it is NOT called automatically.
author: Claude Code
version: 1.0.0
date: 2026-02-22
---

# Grafema CALL Node Argument Edge Gaps

## Problem

PASSES_ARGUMENT (or similar argument-tracing) edges are missing on some CALL nodes
despite the infrastructure (ArgumentExtractor, CallFlowBuilder) being fully implemented.

## Context / Trigger Conditions

- `CALL "foo"` node has no PASSES_ARGUMENT edges, but `CALL "obj.method"` does
- Argument edges work at module level but not inside function bodies (or vice versa)
- `new Foo(arg)` CALL nodes have no argument edges
- Any edge type that should link CALL nodes to their argument nodes shows partial coverage

## Root Cause

Grafema has **two separate argument extraction systems**:

1. **`ArgumentExtractor.extract()`** — used at module level (in `CallExpressionVisitor`)
2. **`extractMethodCallArguments()`** — used inside function bodies (in `JSASTAnalyzer`)

Both feed into `CallFlowBuilder.bufferArgumentEdges()` which creates the actual graph edges.

**The key problem:** These extractors must be called EXPLICITLY at each CALL node creation
site. There are **5 creation sites**, and each must call the appropriate extractor:

| Site | File | Node Type | Extractor | Was it called before REG-556? |
|------|------|-----------|-----------|-------------------------------|
| `handleDirectCall` | `CallExpressionVisitor.ts` | CALL (module) | `ArgumentExtractor.extract` | ✓ YES |
| `handleSimpleMethodCall` | `CallExpressionVisitor.ts` | CALL (module) | `ArgumentExtractor.extract` | ✓ YES |
| `handleNewExpression` (Identifier) | `CallExpressionVisitor.ts` | CALL (module) | `ArgumentExtractor.extract` | ✗ NO (Gap #2) |
| `handleNewExpression` (MemberExpression) | `CallExpressionVisitor.ts` | CALL (module) | `ArgumentExtractor.extract` | ✗ NO (Gap #2) |
| `handleCallExpression` (MemberExpression) | `JSASTAnalyzer.ts` | CALL (function body) | `extractMethodCallArguments` | ✓ YES |
| `handleCallExpression` (Identifier) | `JSASTAnalyzer.ts` | CALL (function body) | `extractMethodCallArguments` | ✗ NO (Gap #1) |
| `NewExpressionHandler` (Identifier, CONSTRUCTOR_CALL) | `NewExpressionHandler.ts` | CONSTRUCTOR_CALL | `ArgumentExtractor.extract` | ✓ YES |
| `NewExpressionHandler` (Identifier, CALL) | `NewExpressionHandler.ts` | CALL (function body) | `ArgumentExtractor.extract` | ✗ NO (Gap #3) |
| `NewExpressionHandler` (MemberExpression, CALL) | `NewExpressionHandler.ts` | CALL (function body) | `ArgumentExtractor.extract` | ✗ NO (Gap #3) |

## Solution

### Debugging Approach

1. Identify which CALL nodes have the missing edges (module-level? function-body? new expressions?)
2. Map the symptom to the creation site table above
3. Read the creation site code — look for `callSites.push(...)` or `methodCalls.push(...)` without a subsequent `ArgumentExtractor.extract()` or `extractMethodCallArguments()` call

### Implementation Pattern

**At module-level creation sites** (`CallExpressionVisitor.ts`):
```typescript
s.callSites.push(callInfo);
// Add after push:
if (node.arguments.length > 0) {
  ArgumentExtractor.extract(
    node.arguments, callInfo.id, s.module,
    s.callArguments, s.literals, s.literalCounterRef,
    this.collections, s.scopeTracker
  );
}
```

**At function-body creation sites** (`JSASTAnalyzer.ts`):
```typescript
callSites.push({ id: callId, ... });
// Add after push:
if (callNode.arguments.length > 0) {
  this.extractMethodCallArguments(callNode, callId, module, collections);
}
```

**At `NewExpressionHandler.ts` creation sites** (mirrors the CONSTRUCTOR_CALL pattern at line 61-66):
```typescript
ctx.callSites.push({ id: newCallId, ... });
// Add after push (same pattern as lines 61-66 for CONSTRUCTOR_CALL):
if (newNode.arguments.length > 0) {
  if (!ctx.collections.callArguments) {
    ctx.collections.callArguments = [];
  }
  ArgumentExtractor.extract(
    newNode.arguments, newCallId, ctx.module,
    ctx.collections.callArguments as unknown as ArgumentInfo[],
    ctx.literals as unknown as ExtractorLiteralInfo[],
    ctx.literalCounterRef, ctx.collections, ctx.scopeTracker
  );
}
```

### Supporting ArgumentExtractor for New Argument Types

If a new argument AST type needs to produce edges, add a branch in both:
- `ArgumentExtractor.extract()` (`ast/visitors/ArgumentExtractor.ts`) — module-level path
- `extractMethodCallArguments()` (`JSASTAnalyzer.ts`) — function-body path

For `NewExpression` as an argument (REG-556 fix):
```typescript
// In ArgumentExtractor.extract, before the final else:
else if (actualArg.type === 'NewExpression') {
  argInfo.targetType = 'CONSTRUCTOR_CALL';
  argInfo.nestedCallLine = actualArg.loc?.start.line;
  argInfo.nestedCallColumn = actualArg.loc?.start.column;
}
```

### Wiring `constructorCalls` into CallFlowBuilder

If you need to resolve `new X()` as an argument target (CONSTRUCTOR_CALL node), you must:

1. Add `constructorCalls = []` to destructuring in `CallFlowBuilder.buffer()`
2. Pass it to `bufferArgumentEdges`
3. Add the 7th parameter to `bufferArgumentEdges` signature
4. Add the resolution branch in `bufferArgumentEdges`

`bufferArgumentEdges` is private with a single call site — safe to extend.

## Verification

```javascript
// Test that CALL node for foo has PASSES_ARGUMENT edges for all arg types:
const edges = await backend.getAllEdges();
const passesArgs = edges.filter(e =>
  e.type === 'PASSES_ARGUMENT' && e.from === fooCallNodeId
);
assert.strictEqual(passesArgs.length, expectedArgCount);
```

## Pre-existing Bug (as of 2026-02-22)

`NewExpressionHandler.ts` line ~122: `ctx.callSites.push` for the Identifier branch
is missing the `column` field. `getColumn(newNode)` is computed at line 41 but is not
carried into the push struct. This means position-based lookup of function-body `new Foo()`
CALL nodes will fail in `CallFlowBuilder`. Does not crash, but CALL-type argument resolution
for these nodes won't work. File a separate issue (not related to argument extraction).

## Notes

- The `as unknown as ArgumentInfo[]` cast in `NewExpressionHandler` is pre-existing pattern
  (line 63) — `CallArgumentInfo` and `ArgumentInfo` are structurally compatible
- `LogicalExpression` / `BinaryExpression` arguments already create EXPRESSION nodes with
  a `targetId` — they work without position lookup. This is the most reliable argument type.
- `SpreadElement` is handled by unwrapping to the inner argument: already works
- Optional chaining calls (`foo?.()`) have type `OptionalCallExpression` — separate code path,
  not covered by these fixes
