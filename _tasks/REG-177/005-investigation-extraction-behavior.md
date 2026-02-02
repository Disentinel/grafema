# Investigation Report: Try/Catch Variable Extraction

## Question
Does JSASTAnalyzer extract variables inside try/catch blocks?

## Findings

### 1. Variable Extraction in Try/Catch Blocks - YES, IT DOES WORK

The `analyzeFunctionBody()` method (line 2477) uses `funcPath.traverse()` with the following flow:

**Line 2612**: `funcPath.traverse({...})` - Traverses the ENTIRE function body, including try/catch blocks.

**Lines 2613-2627**: The `VariableDeclaration` handler fires for ANY variable declaration:
```typescript
VariableDeclaration: (varPath: NodePath<t.VariableDeclaration>) => {
  this.handleVariableDeclaration(
    varPath,
    getCurrentScopeId(),
    module,
    variableDeclarations,
    // ... more params
  );
}
```

### 2. Try/Catch Blocks ARE Tracked

**Lines 2768-2785**: Explicit handlers for `TryStatement` and `CatchClause`.

**Lines 1881-1976**: Creates separate scopes:
- try-block scope (line 1895)
- catch-block scope (line 1911)
- finally-block scope (line 1927)

**Line 1871**: Comment states: **"Does NOT use skip() - allows normal traversal for CallExpression/NewExpression visitors."**

### 3. Flow Chart: Variable Inside Try Block

```
1. funcPath.traverse() starts
   │
2. Encounters try { ... } statement
   ├─ TryStatement handler fires (enter)
   │  └─ Creates try-block scope
   │  └─ Pushes try-block scope onto scopeIdStack
   │  └─ Does NOT skip() - continues traversal
   │
3. Traversal descends into try block body
   │
4. Encounters: const response = await fetch(...)
   └─ VariableDeclaration handler fires
      ├─ Calls getCurrentScopeId()
      │  └─ Returns try-block scope ID
      ├─ Calls handleVariableDeclaration()
      │  └─ Creates VARIABLE node with parentScopeId = try-block scope
      └─ Variable is extracted!
```

### 4. No Special Handling That Would Block Extraction

- `skip()` is only called for FunctionExpression (line 2841) and ArrowFunctionExpression (line 2960)
- No skip() is called for try/catch blocks
- No condition filters out variables based on being inside try blocks

## Conclusion

**Variables inside try/catch blocks SHOULD be extracted.** The JSASTAnalyzer code shows:

1. `funcPath.traverse()` traverses entire tree including try/catch
2. VariableDeclaration handler fires for ANY variable declaration
3. Try/catch blocks have their own scopes but this doesn't prevent extraction
4. No skip() calls prevent try/catch traversal

## If Variables Are Missing, Possible Causes

- **Semantic ID collision** (same variable name in different scopes getting same ID)
- **Scope resolution bug** (try-block scope not being created/stored correctly)
- **Query UX issue** (variables ARE extracted but user can't find them)
- **Edge case bug** in specific patterns

## Recommendation

The "known limitation" of try/catch variables not being extracted is **FALSE**. The `explain` command should NOT be built on this assumption.

However, the core problem remains valid: **users have difficulty understanding what Grafema extracted**. The `explain` command can still help with:
1. Showing what nodes exist for a file
2. Helping users discover nodes they couldn't find via query
3. Diagnosing actual extraction issues (bugs, not design limitations)

The feature should be repositioned from "explain known limitations" to "help understand/debug graph contents for a file".
