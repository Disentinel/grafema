# Don Melton - Phase 4 Review: REG-98 Status Assessment

## Executive Summary

**We got sidetracked.**

REG-98 was about migrating node creation to NodeFactory. We pivoted to building a Semantic ID system that wasn't in the original scope. The infrastructure is good, but we haven't touched the actual task.

---

## What REG-98 Asked For

Original task from Linear:

1. Create missing factory methods for node types without them
2. Update all visitors to use factory methods
3. Update GraphBuilder to use factory methods
4. Add TypeScript type enforcement to prevent inline creation

**Node types listed:**
- CLASS, IMPORT, EXPORT, EXTERNAL_MODULE
- INTERFACE, TYPE, ENUM, DECORATOR, EXPRESSION
- net:stdio, net:request
- OBJECT_LITERAL, ARRAY_LITERAL

**Files to update:**
- GraphBuilder.ts - 18 inline node creations
- CallExpressionVisitor.ts - 18 push() calls
- ImportExportVisitor.ts - 11 push() calls
- FunctionVisitor.ts - 7 push() calls
- VariableVisitor.ts - 5 push() calls
- TypeScriptVisitor.ts - 5 push() calls
- ClassVisitor.ts - 4 push() calls

---

## What We Actually Did

We built a Semantic ID system:

1. Created `SemanticId.ts` - ID generation logic
2. Created `ScopeTracker.ts` - scope tracking during traversal
3. Added `createWithContext()` to 8 node contracts
4. Created 5 new test files (171 tests)

This is good work. But it's not REG-98.

---

## Current State

### NodeFactory.ts

**EXISTS in factory:**
- SERVICE, ENTRYPOINT, MODULE
- FUNCTION, SCOPE, CALL_SITE, METHOD_CALL
- VARIABLE_DECLARATION, CONSTANT, LITERAL
- OBJECT_LITERAL, ARRAY_LITERAL (already done - remove from scope)
- EXTERNAL_STDIO, EVENT_LISTENER, HTTP_REQUEST, DATABASE_QUERY
- IMPORT

**MISSING from factory (per REG-98 scope):**
- CLASS - NodeFactory.createClass() does NOT exist
- EXPORT - NodeFactory.createExport() does NOT exist
- EXTERNAL_MODULE - no contract or factory method
- INTERFACE - no contract or factory method
- TYPE - no contract or factory method
- ENUM - no contract or factory method
- DECORATOR - no contract or factory method
- EXPRESSION - no contract or factory method
- net:request - HttpRequestNode exists but ID format may be wrong

### GraphBuilder.ts

Still has **28 inline `_bufferNode({...})` calls**. Zero migration done.

### Visitors

Still have **50+ inline `.push({...})` calls**. Zero migration done.

---

## Linus's Questions From Review (004)

1. **ID format** - Decided: use `->` separator. Implemented in SemanticId.
2. **EXPRESSION node** - NOT DONE. No contract, no factory method.
3. **OBJECT_LITERAL/ARRAY_LITERAL** - Already done. Removed from scope.
4. **ExportNode.source** - NOT DONE. ExportNode.ts exists but may need source field.
5. **Backward compatibility** - Decided: clear data. No action needed yet.

---

## What Needs to Happen

### Option A: Complete REG-98 as Originally Scoped

Ignore Semantic IDs for now. Just create the missing factory methods and migrate inline creations.

**Part 1 - Create missing factory methods:**
1. NodeFactory.createClass()
2. NodeFactory.createExport()
3. NodeFactory.createExternalModule() - new contract
4. NodeFactory.createInterface() - new contract
5. NodeFactory.createType() - new contract
6. NodeFactory.createEnum() - new contract
7. NodeFactory.createDecorator() - new contract
8. NodeFactory.createExpression() - new contract

**Part 2 - Migrate GraphBuilder:**
Replace 28 inline `_bufferNode({...})` with factory calls.

**Part 3 - Migrate Visitors:**
Replace 50+ inline `.push({...})` with factory calls (where applicable).

Estimated effort: 2-3 days of focused work.

### Option B: Integrate Semantic IDs First

Before migrating, integrate the Semantic ID system into the analysis pipeline. This changes the migration target.

**Problem**: This is scope creep. We'd be doing TWO things at once:
1. NodeFactory migration (REG-98)
2. Semantic ID integration (not in REG-98)

I don't recommend this. Finish one thing at a time.

---

## My Recommendation

**Finish REG-98 as originally scoped (Option A).**

1. Create the 8 missing factory methods (Part 1)
2. Migrate GraphBuilder (Part 2)
3. Migrate Visitors (Part 3)
4. Mark REG-98 as done

Then create a NEW issue for Semantic ID integration:
- "Integrate Semantic IDs into analysis pipeline"
- Depends on REG-98
- Uses the infrastructure we built

The Semantic ID work we did is good foundation. But we shouldn't conflate two different tasks.

---

## Immediate Next Steps

1. **Joel**: Write detailed tech plan for Part 1 (8 factory methods)
2. **Kent**: Write tests for the 8 factory methods
3. **Rob**: Implement the 8 factory methods
4. **Review cycle**, then Part 2

Or if user prefers: acknowledge the scope change, create separate Linear issue for Semantic ID integration, and decide which to prioritize.

---

## Questions for User

1. Should we complete REG-98 as originally scoped (factory methods + migration)?
2. Or pivot to a new task focused on Semantic ID integration?
3. Should we create a separate Linear issue for the Semantic ID integration work?

The Semantic ID infrastructure is done and tested. The question is: what do we ship next?

---

**NEEDS DIRECTION**

We can't proceed without knowing which path to take.
