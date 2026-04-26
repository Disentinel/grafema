# REG-106: DecoratorNode and DECORATOR Migration Analysis

**Tech Lead Analysis by Don Melton**

## Summary

After exploring the codebase, **DecoratorNode is already fully implemented**, and **NodeFactory.createDecorator() already exists**. The only remaining work is migrating `GraphBuilder.bufferDecoratorNodes()` to use the factory instead of inline object literals.

This is a straightforward migration following the exact pattern used for InterfaceNode (REG-103), EnumNode (REG-105), ExportNode (REG-101), and ImportNode (REG-100).

**Verdict: GO.** This is the RIGHT approach and follows established patterns.

---

## 1. Current State

### DecoratorNode Contract (Already Exists)

**Location:** `/packages/core/src/core/nodes/DecoratorNode.ts`

- `DecoratorNode.create()` - factory method
- `DecoratorNode.validate()` - validation method
- **ID Format:** `{file}:DECORATOR:{name}:{line}:{column}`

### NodeFactory Integration (Already Complete)

**Location:** `/packages/core/src/core/NodeFactory.ts:442-452`

The factory method already exists and delegates to DecoratorNode.create().

### Current Inline Creation (The Problem)

**Location:** `GraphBuilder.bufferDecoratorNodes()` — Lines 1186-1207

Uses inline object literal instead of `DecoratorNode.create()`.

**Critical Bug:** The inline literal is **missing the targetId field** in the node itself! Only used in edge construction.

---

## 2. ID Format Mismatch

- **ClassVisitor generates:** `DECORATOR#Injectable#/path/file.ts#5:0` (legacy)
- **DecoratorNode.create() produces:** `/path/file.ts:DECORATOR:Injectable:5:0` (new)

**Solution:** Don't use the ID from DecoratorInfo. Use DecoratorNode.create() which generates the correct colon format ID. This follows the pattern used for EnumNode (REG-105) and InterfaceNode (REG-103).

---

## 3. High-Level Migration Plan

### Phase 1: Test First (Kent Beck)
- Unit tests for DecoratorNode.create()
- Verify targetId is present in persisted nodes
- Verify ID format

### Phase 2: Migrate GraphBuilder (Rob Pike)
- Update `bufferDecoratorNodes()` to use `DecoratorNode.create()`
- Add import for DecoratorNode
- Use factory-generated ID (colon format) instead of legacy ID

---

## 4. Files to Modify

| File | Change |
|------|--------|
| `/test/unit/DecoratorNodeMigration.test.js` | Create new - TDD |
| `/packages/core/src/plugins/analysis/ast/GraphBuilder.ts` | Import DecoratorNode, update bufferDecoratorNodes() |

---

## 5. Risks and Mitigations

### ID Format Change
- This is a fresh database rebuild, so old IDs don't persist
- All recent migrations (InterfaceNode, EnumNode) made this change successfully

### Missing targetId Bug
- This migration fixes it
- NodeFactory validation will catch future violations

### Column in Decorator IDs
- Correct because multiple decorators can be on the same line
- Column disambiguates them

---

## 6. Verdict

**GO. This migration is RIGHT.**

- DecoratorNode is fully implemented
- Pattern is proven across 4 other node types
- Migration fixes an existing bug (missing targetId)
- Only one file needs to change (GraphBuilder)
