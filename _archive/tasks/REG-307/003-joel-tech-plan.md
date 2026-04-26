# Joel's Technical Plan: REG-307 - Natural Language Query Support

## Overview

This document provides the detailed technical specification for implementing natural language scope queries in the `grafema query` command. Kent Beck and Rob Pike can implement directly from this spec.

Based on Don's high-level plan (Option A), we extend the existing `parsePattern()` function to support `" in <scope>"` syntax while maintaining backward compatibility.

---

## File Changes

**Single file to modify:** `packages/cli/src/commands/query.ts`

---

## Step 1: Define New Types

Add these interfaces after line 42 (after the existing `NodeInfo` interface):

```typescript
/**
 * Parsed query with optional scope constraints.
 *
 * Supports patterns like:
 *   "response" -> { name: "response" }
 *   "variable response" -> { type: "VARIABLE", name: "response" }
 *   "response in fetchData" -> { name: "response", scopes: ["fetchData"] }
 *   "response in src/app.ts" -> { name: "response", file: "src/app.ts" }
 *   "response in catch in fetchData" -> { name: "response", scopes: ["fetchData", "catch"] }
 */
interface ParsedQuery {
  /** Node type (e.g., "FUNCTION", "VARIABLE") or null for any */
  type: string | null;
  /** Node name to search (partial match) */
  name: string;
  /** File scope - filter to nodes in this file */
  file: string | null;
  /** Scope chain - filter to nodes inside these scopes (function/class/block names) */
  scopes: string[];
}
```

---

## Step 2: Create `parseQuery()` Function

Create a new function that replaces the functionality of `parsePattern()` but also handles scope clauses. Add this after the existing `parsePattern()` function (around line 233):

```typescript
/**
 * Parse search pattern with scope support.
 *
 * Grammar:
 *   query := [type] name [" in " scope]*
 *   type  := "function" | "class" | "variable" | etc.
 *   scope := <filename> | <functionName>
 *
 * File scope detection: contains "/" or ends with .ts/.js/.tsx/.jsx
 * Function scope detection: anything else
 *
 * IMPORTANT: Only split on " in " (space-padded) to avoid matching names like "signin"
 *
 * Examples:
 *   "response" -> { type: null, name: "response", file: null, scopes: [] }
 *   "variable response in fetchData" -> { type: "VARIABLE", name: "response", file: null, scopes: ["fetchData"] }
 *   "response in src/app.ts" -> { type: null, name: "response", file: "src/app.ts", scopes: [] }
 *   "error in catch in fetchData in src/app.ts" -> { type: null, name: "error", file: "src/app.ts", scopes: ["fetchData", "catch"] }
 */
function parseQuery(pattern: string): ParsedQuery {
  // Split on " in " (space-padded) to get clauses
  const clauses = pattern.split(/ in /);

  // First clause is [type] name - use existing parsePattern logic
  const firstClause = clauses[0];
  const { type, name } = parsePattern(firstClause);

  // Remaining clauses are scopes
  let file: string | null = null;
  const scopes: string[] = [];

  for (let i = 1; i < clauses.length; i++) {
    const scope = clauses[i].trim();
    if (isFileScope(scope)) {
      file = scope;
    } else {
      scopes.push(scope);
    }
  }

  return { type, name, file, scopes };
}

/**
 * Detect if a scope string looks like a file path.
 *
 * Heuristics:
 * - Contains "/" -> file path
 * - Ends with .ts, .js, .tsx, .jsx, .mjs, .cjs -> file path
 * - Contains "." but doesn't look like a method call -> file path
 *
 * Examples:
 *   "src/app.ts" -> true
 *   "app.js" -> true
 *   "fetchData" -> false
 *   "UserService" -> false
 *   "catch" -> false
 */
function isFileScope(scope: string): boolean {
  // Contains path separator
  if (scope.includes('/')) return true;

  // Ends with common JS/TS extensions
  const fileExtensions = /\.(ts|js|tsx|jsx|mjs|cjs)$/i;
  if (fileExtensions.test(scope)) return true;

  return false;
}
```

---

## Step 3: Create `matchesScope()` Function

Add this function to check if a semantic ID matches the scope constraints:

```typescript
/**
 * Check if a semantic ID matches the given scope constraints.
 *
 * Scope matching rules:
 * - File scope: semantic ID must start with the file path
 * - Function/class scope: semantic ID must contain "->scopeName->" or "->scopeName#"
 * - Multiple scopes: ALL must match (AND logic)
 * - Scope order: inner scopes should appear after outer scopes in the ID
 *
 * Examples:
 *   ID: "src/app.ts->fetchData->try#0->VARIABLE->response"
 *   Matches: scopes=["fetchData"] -> true
 *   Matches: scopes=["try"] -> true (matches "try#0")
 *   Matches: scopes=["fetchData", "try"] -> true (both present)
 *   Matches: scopes=["processData"] -> false (not in ID)
 *
 * @param semanticId - The full semantic ID to check
 * @param file - File scope (null for any file)
 * @param scopes - Array of scope names to match
 * @returns true if ID matches all constraints
 */
function matchesScope(semanticId: string, file: string | null, scopes: string[]): boolean {
  // File scope check
  if (file !== null) {
    // Handle both exact match and partial path match
    // "src/app.ts" should match ID starting with "src/app.ts->"
    if (!semanticId.startsWith(file + '->') && !semanticId.includes('/' + file + '->')) {
      return false;
    }
  }

  // Function/class/block scope check
  for (const scope of scopes) {
    // Match scope name in the ID:
    // - "->scopeName->" for scopes that contain other elements
    // - "->scopeName#" for numbered scopes like "try#0", "catch#1"
    // - "->scopeName->" at the end before type
    const scopePattern = new RegExp(`->${escapeRegExp(scope)}(->|#\\d+->)`);
    if (!scopePattern.test(semanticId)) {
      return false;
    }
  }

  return true;
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
```

---

## Step 4: Create `extractScopeContext()` Function

Add this function to generate human-readable scope context from semantic IDs (reusing the logic from FileExplainer but standalone):

```typescript
/**
 * Extract human-readable scope context from a semantic ID.
 *
 * Parses the ID and returns a description of the scope chain.
 *
 * Examples:
 *   "src/app.ts->fetchData->try#0->VARIABLE->response"
 *   -> "inside fetchData, inside try block"
 *
 *   "src/app.ts->UserService->login->VARIABLE->token"
 *   -> "inside UserService.login"
 *
 *   "src/app.ts->global->FUNCTION->main"
 *   -> null (no interesting scope)
 *
 * @param semanticId - The semantic ID to parse
 * @returns Human-readable scope context or null
 */
function extractScopeContext(semanticId: string): string | null {
  // Parse the semantic ID
  const parts = semanticId.split('->');
  if (parts.length < 4) return null;

  // parts[0] = file
  // parts[1...-2] = scope path
  // parts[-2] = type
  // parts[-1] = name

  const scopePath = parts.slice(1, -2);

  // Filter out "global" and format remaining scopes
  const meaningfulScopes = scopePath.filter(s => s !== 'global');
  if (meaningfulScopes.length === 0) return null;

  // Format each scope with context
  const formatted = meaningfulScopes.map(scope => {
    // Handle numbered scopes: "try#0" -> "try block"
    if (scope.match(/^try#\d+$/)) return 'try block';
    if (scope.match(/^catch#\d+$/)) return 'catch block';
    if (scope.match(/^if#\d+$/)) return 'conditional';
    if (scope.match(/^else#\d+$/)) return 'else block';
    if (scope.match(/^for#\d+$/)) return 'loop';
    if (scope.match(/^while#\d+$/)) return 'loop';
    if (scope.match(/^switch#\d+$/)) return 'switch';

    // Regular scope: function or class name
    return scope;
  });

  // Build "inside X, inside Y" string
  return 'inside ' + formatted.join(', inside ');
}
```

---

## Step 5: Modify `findNodes()` Function

Update the `findNodes()` function (starting at line 331) to accept and apply scope constraints:

### 5.1 Update Function Signature

Change from:
```typescript
async function findNodes(
  backend: RFDBServerBackend,
  type: string | null,
  name: string,
  limit: number
): Promise<NodeInfo[]>
```

To:
```typescript
async function findNodes(
  backend: RFDBServerBackend,
  query: ParsedQuery,
  limit: number
): Promise<NodeInfo[]>
```

### 5.2 Update Function Body

The function body becomes:

```typescript
async function findNodes(
  backend: RFDBServerBackend,
  query: ParsedQuery,
  limit: number
): Promise<NodeInfo[]> {
  const results: NodeInfo[] = [];
  const searchTypes = query.type
    ? [query.type]
    : [
        'FUNCTION',
        'CLASS',
        'MODULE',
        'VARIABLE',
        'CONSTANT',
        'http:route',
        'http:request',
        'socketio:event',
        'socketio:emit',
        'socketio:on'
      ];

  for (const nodeType of searchTypes) {
    // If file scope is specified, we could optimize by querying with file filter
    // For now, we filter client-side (matches current behavior)
    for await (const node of backend.queryNodes({ nodeType: nodeType as any })) {
      // Name matching (existing logic)
      const nameMatches = matchesSearchPattern(node, nodeType, query.name);
      if (!nameMatches) continue;

      // Scope matching (new logic)
      const scopeMatches = matchesScope(node.id, query.file, query.scopes);
      if (!scopeMatches) continue;

      // Build node info (existing logic)
      const nodeInfo: NodeInfo = {
        id: node.id,
        type: node.type || nodeType,
        name: node.name || '',
        file: node.file || '',
        line: node.line,
      };

      // Include type-specific fields (existing logic - unchanged)
      if (nodeType === 'http:route') {
        nodeInfo.method = node.method as string | undefined;
        nodeInfo.path = node.path as string | undefined;
      }
      // ... rest of type-specific field copying unchanged ...

      results.push(nodeInfo);
      if (results.length >= limit) break;
    }
    if (results.length >= limit) break;
  }

  return results;
}
```

---

## Step 6: Update Action Handler

Modify the action handler (starting at line 96) to use `parseQuery()` and pass the full `ParsedQuery` to `findNodes()`.

### Current Code (lines 115-133):

```typescript
// Determine type: explicit --type flag takes precedence
let searchType: string | null;
let searchName: string;

if (options.type) {
  // Explicit --type bypasses pattern parsing for type
  searchType = options.type;
  searchName = pattern;
} else {
  // Use pattern parsing for type aliases
  const parsed = parsePattern(pattern);
  searchType = parsed.type;
  searchName = parsed.name;
}

const limit = parseInt(options.limit, 10);

// Find matching nodes
const nodes = await findNodes(backend, searchType, searchName, limit);
```

### New Code:

```typescript
const limit = parseInt(options.limit, 10);

// Parse query with scope support
let query: ParsedQuery;

if (options.type) {
  // Explicit --type bypasses pattern parsing for type
  // But we still parse for scope support
  const scopeParsed = parseQuery(pattern);
  query = {
    type: options.type,
    name: scopeParsed.name,
    file: scopeParsed.file,
    scopes: scopeParsed.scopes,
  };
} else {
  query = parseQuery(pattern);
}

// Find matching nodes
const nodes = await findNodes(backend, query, limit);
```

---

## Step 7: Enhance Node Display with Scope Context

Update the `displayNode()` function to show scope context for each result.

### 7.1 Add Context to NodeInfo Interface

Extend the `NodeInfo` interface (around line 27) to include context:

```typescript
interface NodeInfo {
  // ... existing fields ...
  /** Human-readable scope context */
  scopeContext?: string;
}
```

### 7.2 Populate Context in findNodes()

After building `nodeInfo` in `findNodes()`, add:

```typescript
// Add scope context for display
nodeInfo.scopeContext = extractScopeContext(node.id);
```

### 7.3 Update formatNodeDisplay or displayNode

In `displayNode()` function, after showing Location, add:

```typescript
// After the Location line, if we have scope context
if (node.scopeContext) {
  console.log(`  Scope: ${node.scopeContext}`);
}
```

For the generic display path (using `formatNodeDisplay`), we need to either:
1. Pass context to formatNodeDisplay (requires interface change in formatNode.ts), OR
2. Handle it in displayNode directly

**Recommended: Handle in displayNode directly** to minimize cross-file changes:

```typescript
async function displayNode(node: NodeInfo, projectPath: string, backend: RFDBServerBackend): Promise<void> {
  // ... existing special case handling for http:route, http:request, etc. ...

  // Default display
  console.log(formatNodeDisplay(node, { projectPath }));

  // Add scope context if present
  if (node.scopeContext) {
    console.log(`  Scope: ${node.scopeContext}`);
  }
}
```

---

## Step 8: Update Help Text

Update the command help text (around line 82) to document the new syntax:

```typescript
.addHelpText('after', `
Examples:
  grafema query "auth"                         Search by name (partial match)
  grafema query "function login"               Search functions only
  grafema query "class UserService"            Search classes only
  grafema query "route /api/users"             Search HTTP routes by path
  grafema query "response in fetchData"        Search in specific function scope
  grafema query "error in catch in fetchData"  Search in nested scopes
  grafema query "token in src/auth.ts"         Search in specific file
  grafema query "variable x in foo in app.ts"  Combine type, name, and scopes
  grafema query -l 20 "fetch"                  Return up to 20 results
  grafema query --json "config"                Output results as JSON
  grafema query --type FUNCTION "auth"         Explicit type (no alias resolution)
  grafema query --raw 'type(X, "FUNCTION")'    Raw Datalog query
`)
```

---

## Implementation Order

Kent Beck (tests first) and Rob Pike (implementation) should proceed in this order:

1. **Tests for parseQuery()** - Unit tests for the new parsing function
2. **Implement parseQuery()** and **isFileScope()** - Pure functions, no dependencies
3. **Tests for matchesScope()** - Unit tests for scope matching
4. **Implement matchesScope()** and **escapeRegExp()** - Pure functions
5. **Tests for extractScopeContext()** - Unit tests for context extraction
6. **Implement extractScopeContext()** - Pure function
7. **Integration tests** - End-to-end CLI tests with real graph
8. **Wire up in action handler** - Connect the pieces
9. **Update displayNode()** - Show scope context
10. **Update help text** - Document new syntax

---

## Test Cases

### Unit Tests for parseQuery()

```typescript
describe('parseQuery', () => {
  it('should parse simple name', () => {
    const result = parseQuery('response');
    assert.deepEqual(result, {
      type: null,
      name: 'response',
      file: null,
      scopes: [],
    });
  });

  it('should parse type + name', () => {
    const result = parseQuery('variable response');
    assert.deepEqual(result, {
      type: 'VARIABLE',
      name: 'response',
      file: null,
      scopes: [],
    });
  });

  it('should parse name + function scope', () => {
    const result = parseQuery('response in fetchData');
    assert.deepEqual(result, {
      type: null,
      name: 'response',
      file: null,
      scopes: ['fetchData'],
    });
  });

  it('should parse name + file scope', () => {
    const result = parseQuery('response in src/app.ts');
    assert.deepEqual(result, {
      type: null,
      name: 'response',
      file: 'src/app.ts',
      scopes: [],
    });
  });

  it('should parse name with extension as file scope', () => {
    const result = parseQuery('response in app.js');
    assert.deepEqual(result, {
      type: null,
      name: 'response',
      file: 'app.js',
      scopes: [],
    });
  });

  it('should parse multiple scopes', () => {
    const result = parseQuery('error in catch in fetchData');
    assert.deepEqual(result, {
      type: null,
      name: 'error',
      file: null,
      scopes: ['catch', 'fetchData'],
    });
  });

  it('should parse full specification', () => {
    const result = parseQuery('variable response in fetchData in src/app.ts');
    assert.deepEqual(result, {
      type: 'VARIABLE',
      name: 'response',
      file: 'src/app.ts',
      scopes: ['fetchData'],
    });
  });

  it('should NOT split on "in" within names (signin)', () => {
    const result = parseQuery('signin');
    assert.deepEqual(result, {
      type: null,
      name: 'signin',
      file: null,
      scopes: [],
    });
  });

  it('should NOT split on "in" without spaces (xindex)', () => {
    const result = parseQuery('function xindex');
    assert.deepEqual(result, {
      type: 'FUNCTION',
      name: 'xindex',
      file: null,
      scopes: [],
    });
  });

  it('should handle nested numbered scopes', () => {
    const result = parseQuery('x in try in processData');
    assert.deepEqual(result, {
      type: null,
      name: 'x',
      file: null,
      scopes: ['try', 'processData'],
    });
  });
});
```

### Unit Tests for matchesScope()

```typescript
describe('matchesScope', () => {
  const testId = 'src/app.ts->fetchData->try#0->VARIABLE->response';

  it('should match with no constraints', () => {
    assert.strictEqual(matchesScope(testId, null, []), true);
  });

  it('should match file scope', () => {
    assert.strictEqual(matchesScope(testId, 'src/app.ts', []), true);
  });

  it('should reject wrong file', () => {
    assert.strictEqual(matchesScope(testId, 'src/other.ts', []), false);
  });

  it('should match function scope', () => {
    assert.strictEqual(matchesScope(testId, null, ['fetchData']), true);
  });

  it('should match numbered scope (try)', () => {
    assert.strictEqual(matchesScope(testId, null, ['try']), true);
  });

  it('should match multiple scopes (AND)', () => {
    assert.strictEqual(matchesScope(testId, null, ['fetchData', 'try']), true);
  });

  it('should reject if any scope missing', () => {
    assert.strictEqual(matchesScope(testId, null, ['fetchData', 'catch']), false);
  });

  it('should match file + function scope', () => {
    assert.strictEqual(matchesScope(testId, 'src/app.ts', ['fetchData']), true);
  });

  it('should reject wrong file even with matching scope', () => {
    assert.strictEqual(matchesScope(testId, 'src/other.ts', ['fetchData']), false);
  });
});
```

### Unit Tests for extractScopeContext()

```typescript
describe('extractScopeContext', () => {
  it('should return null for global scope', () => {
    const result = extractScopeContext('src/app.ts->global->FUNCTION->main');
    assert.strictEqual(result, null);
  });

  it('should format function scope', () => {
    const result = extractScopeContext('src/app.ts->fetchData->VARIABLE->response');
    assert.strictEqual(result, 'inside fetchData');
  });

  it('should format try block', () => {
    const result = extractScopeContext('src/app.ts->fetchData->try#0->VARIABLE->response');
    assert.strictEqual(result, 'inside fetchData, inside try block');
  });

  it('should format catch block', () => {
    const result = extractScopeContext('src/app.ts->processData->catch#0->VARIABLE->error');
    assert.strictEqual(result, 'inside processData, inside catch block');
  });

  it('should format nested class.method scope', () => {
    const result = extractScopeContext('src/app.ts->UserService->login->VARIABLE->token');
    assert.strictEqual(result, 'inside UserService, inside login');
  });

  it('should format conditional', () => {
    const result = extractScopeContext('src/app.ts->validate->if#0->VARIABLE->isValid');
    assert.strictEqual(result, 'inside validate, inside conditional');
  });
});
```

### Integration Tests (CLI)

Add to a new file: `packages/cli/test/query-scope.test.ts`

```typescript
describe('grafema query with scope support', { timeout: 60000 }, () => {
  // ... setup helpers similar to query-type-flag.test.ts ...

  it('should find variable in specific function', async () => {
    await setupTestProject();

    const result = runCli(['query', 'response in fetchData'], tempDir);

    assert.strictEqual(result.status, 0);
    assert.ok(result.stdout.includes('response'));
    assert.ok(result.stdout.includes('fetchData'));
  });

  it('should filter by file scope', async () => {
    await setupTestProject();

    const result = runCli(['query', 'response in src/app.js'], tempDir);

    assert.strictEqual(result.status, 0);
    // Should only show results from src/app.js
  });

  it('should combine type and scope', async () => {
    await setupTestProject();

    const result = runCli(['query', 'variable response in fetchData'], tempDir);

    assert.strictEqual(result.status, 0);
    // Should find VARIABLE nodes named "response" inside fetchData
  });

  it('should show scope context in output', async () => {
    await setupTestProject();

    const result = runCli(['query', 'response'], tempDir);

    assert.strictEqual(result.status, 0);
    // Output should include "Scope: inside fetchData" or similar
  });

  it('should not split on "in" within names', async () => {
    await setupTestProjectWithSignin();

    const result = runCli(['query', 'signin'], tempDir);

    assert.strictEqual(result.status, 0);
    assert.ok(result.stdout.includes('signin'));
    // Should find the signin function, not parse as "sign in n"
  });
});
```

---

## Edge Cases to Handle

1. **Names containing "in"**: `signin`, `main`, `index` - only split on ` in ` (space-padded)
2. **Empty scopes**: `"response in "` - ignore trailing empty clauses
3. **File paths with spaces**: Not common in JS projects, defer handling
4. **Partial file matches**: `"in app.ts"` should match `"src/app.ts"` - handle in matchesScope
5. **Case sensitivity**: Scopes should be case-sensitive (function names are case-sensitive in JS)
6. **No results with scope**: Show helpful message suggesting to remove scope constraint

---

## Error Messages

When no results found with scope constraints, show:

```
No results for "response in fetchData"
  Try: grafema query "response" (search all scopes)
  Try: grafema explain src/app.ts (see what's in the file)
```

---

## Backward Compatibility

All existing query patterns continue to work unchanged:
- `grafema query "response"` - name-only search
- `grafema query "function authenticate"` - type + name
- `grafema query --type FUNCTION "auth"` - explicit type
- `grafema query --raw 'type(X, "FUNCTION")'` - raw Datalog

The only change is that patterns containing ` in ` (space-padded) are now parsed as scope constraints.

---

## Summary

This is a focused, single-file change that adds natural language scope support while maintaining full backward compatibility. The implementation uses client-side filtering (parsing semantic IDs) which is simple and sufficient for current scale.

**Key decisions:**
- Split on ` in ` (space-padded) to avoid breaking names like "signin"
- File detection via path separator and extensions
- Exact scope name matching (not substring)
- AND logic for multiple scopes
- Scope context shown in output for all results

**Effort: ~1 day for implementation, ~0.5 day for tests**

---

*Joel Spolsky, Implementation Planner*
*"Make it work, make it right, make it fast - in that order."*
