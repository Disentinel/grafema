---
name: grafema-module-level-scope-matching
description: |
  Fix Grafema scope chain resolution when module-level scope path `[]` doesn't match
  semantic ID scope `['global']`. Use when: (1) scope-aware lookups fail for module-level
  variables, (2) mutations at file level don't resolve to correct variables, (3)
  `resolveVariableInScope()` returns null for module-level variables despite them existing.
  Root cause: `computeSemanticId()` converts empty scope path to 'global' string, but
  comparison uses empty array.
author: Claude Code
version: 1.0.0
date: 2026-02-02
---

# Grafema Module-Level Scope Matching

## Problem

In Grafema's scope chain resolution, module-level variable lookups fail because the
mutation scope path (`[]`) doesn't match the variable's semantic ID scope (`['global']`).

## Context / Trigger Conditions

- Scope-aware variable lookup returns `null` for module-level variables
- Mutations at module level don't create edges to their target variables
- `resolveVariableInScope()` fails even though the variable exists
- Test assertions like "Variable not found" for top-level variables

## Root Cause

In `SemanticId.ts`, when `computeSemanticId()` generates IDs:

```typescript
const scope = scopePath.length > 0 ? scopePath.join('->') : 'global';
let id = `${file}->${scope}->${type}->${name}`;
```

- Empty scope path `[]` becomes string `'global'`
- Semantic ID: `file->global->VARIABLE->name`
- When `parseSemanticId()` parses this: `scopePath = ['global']`

But mutation info stores raw scope path from `ScopeTracker`:
- Module-level mutation has `mutationScopePath = []` (empty array)

**Comparison `[] === ['global']` fails**, so lookup returns null.

## Solution

In scope chain resolution, add special case for module-level matching:

```typescript
private resolveVariableInScope(
  name: string,
  scopePath: string[],
  file: string,
  variables: VariableDeclarationInfo[]
): VariableDeclarationInfo | null {
  for (let i = scopePath.length; i >= 0; i--) {
    const searchScopePath = scopePath.slice(0, i);

    const matchingVar = variables.find(v => {
      if (v.name !== name || v.file !== file) return false;

      const parsed = parseSemanticId(v.id);
      if (parsed && parsed.type === 'VARIABLE') {
        // CRITICAL: Handle module-level scope matching
        // Empty search scope [] should match semantic ID scope ['global']
        if (searchScopePath.length === 0) {
          return parsed.scopePath.length === 1 && parsed.scopePath[0] === 'global';
        }
        // Non-empty scope: exact match
        return this.scopePathsMatch(parsed.scopePath, searchScopePath);
      }

      // Legacy ID - assume module-level if no semantic ID
      return searchScopePath.length === 0;
    });

    if (matchingVar) return matchingVar;
  }
  return null;
}
```

## Verification

1. Module-level mutations create correct edges:
   ```javascript
   let count = 0;
   count += 1;  // FLOWS_INTO edge to module-level count
   ```

2. Test assertion passes:
   ```javascript
   const countVar = allNodes.find(n => n.name === 'count');
   const flowsInto = allEdges.find(e => e.dst === countVar.id);
   assert.ok(flowsInto);  // Should pass
   ```

## Example

Before fix:
```
let x = 1;
x += 2;  // Mutation scope: []
         // Variable semantic ID: file->global->VARIABLE->x
         // parseSemanticId returns scopePath: ['global']
         // Comparison: [] vs ['global'] = NO MATCH
         // Result: No FLOWS_INTO edge created
```

After fix:
```
let x = 1;
x += 2;  // Mutation scope: []
         // searchScopePath.length === 0 triggers special case
         // Checks: parsed.scopePath === ['global'] = MATCH
         // Result: FLOWS_INTO edge correctly created
```

## Notes

- This pattern applies to any scope-aware resolution in Grafema (variables, parameters)
- The same fix is needed in `resolveParameterInScope()` for parameters
- Scope chain walk still works for nested scopes - this only affects module-level
- Always test module-level mutations explicitly when adding scope-aware features
