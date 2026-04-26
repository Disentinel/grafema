# Linus Torvalds - Plan Review: NodeFactory Migration (REG-98)

## Summary

The plan is solid. Don and Joel understood the problem correctly. But there are issues to fix before implementing.

---

## ID Format Decision: WRONG

**The problem**: Plan contradicts itself.
- Joel says standardize on colon-separated format
- But then says singletons keep hash: `net:stdio#__stdio__`
- Current `ExternalStdioNode.SINGLETON_ID` uses colon: `EXTERNAL_STDIO:__stdio__`

**Verdict**: Pick ONE format. Colon everywhere. No exceptions.

---

## 6 New Contract Files: ACCEPTABLE

Not over-engineering. Each node type needs its own validation and ID generation. Following established pattern is correct.

---

## Missing from the Plan

### 1. EXPRESSION node
User request lists EXPRESSION. Plan ignores it. Where is it?

### 2. OBJECT_LITERAL and ARRAY_LITERAL
User request mentions these. But `ObjectLiteralNode.ts` and `ArrayLiteralNode.ts` already exist. And NodeFactory already has `createObjectLiteral()` and `createArrayLiteral()`.

Clarify: Already done? Remove from scope?

### 3. ExportNode.source field
Joel's `ExportOptions` includes `source?: string` but existing `ExportNode.ts` may not have it. Add it or remove from plan.

---

## Implementation Order: CORRECT

Phasing makes sense. Good sequencing.

---

## Backward Compatibility: NOT ADDRESSED

What happens to existing data when ID format changes from `INTERFACE#name#file#line` to `file:INTERFACE:name:line`?

Options:
1. Migration script
2. Support both formats (gross)
3. Clear all data before migration (acceptable for dev phase)

**State which approach and why.**

---

## Required Changes

Before implementation:

1. **ID format** - Pick colon everywhere, no exceptions
2. **EXPRESSION node** - In scope or not?
3. **OBJECT_LITERAL/ARRAY_LITERAL** - Verify status, remove from scope if done
4. **ExportNode.source** - Add to contract if needed
5. **Backward compatibility** - State approach explicitly

---

**NEEDS REVISION**

Fix the ID format contradiction and address missing/unclear scope items.
