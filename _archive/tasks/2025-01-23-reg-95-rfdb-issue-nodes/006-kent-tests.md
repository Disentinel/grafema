# Kent Beck's Test Report: REG-95 ISSUE Nodes

## Summary

Created TDD tests for the ISSUE nodes feature as specified in Joel's technical plan (003-joel-tech-plan.md) with MVP scope from clarifications (005-clarifications.md).

## Test Files Created

### 1. `/test/unit/core/nodes/IssueNode.test.js` (NEW)

Tests for the `IssueNode` contract class covering:

**ID Generation (6 tests)**
- `generateId()` produces deterministic IDs (same inputs = same output)
- Different inputs produce different IDs (lines, categories, plugins, messages)
- ID format verification: `issue:<category>#<12-char-hash>`
- SHA256 hex hash validation

**Node Creation (14 tests)**
- `create()` creates valid issue node with all required fields
- Default column value (0 when not provided)
- `createdAt` timestamp set to current time
- `name` truncation to 100 chars (message preserved fully)
- Context option passed through correctly
- Different types for different categories (security, performance, style, smell, custom)
- Validation errors for missing: category, severity, message, plugin, file
- Invalid severity rejection (only error/warning/info allowed)
- All three severity values accepted

**ID Parsing (8 tests)**
- `parseId()` extracts category and hash from valid IDs
- Returns null for invalid formats, empty strings, missing hash
- Rejects non-issue IDs (guarantee:*, FUNCTION, etc.)
- Handles null/undefined input

**Type Checking (9 tests)**
- `isIssueType()` returns true for all issue:* types
- Returns false for FUNCTION, guarantee:*, MODULE, http:*, empty, null, undefined

**Validation (7 tests)**
- `validate()` returns empty array for valid nodes
- Reports errors for missing category, severity, message, plugin
- Reports errors for invalid severity values
- Reports errors for wrong type prefix (not issue:*)

**getCategories (5 tests)**
- Returns array with at least 4 categories
- Includes: security, performance, style, smell

### 2. `/test/unit/core/NodeFactoryIssue.test.js` (NEW)

Tests for `NodeFactory.createIssue()` method covering:

**Basic Creation (3 tests)**
- Creates issue node with required fields only
- Default column (0) when omitted
- Context option passed through

**Different Issue Types (5 tests)**
- Security, performance, style, smell, custom categories

**ID Generation (2 tests)**
- Deterministic IDs
- Different locations produce different IDs

**Validation via NodeFactory.validate (2 tests)**
- Valid issue node passes validation
- Issue with context passes validation

**Error Handling (5 tests)**
- Throws for empty category, invalid severity, empty message, empty plugin, empty file

**Node Properties (2 tests)**
- createdAt timestamp set
- Name truncation to 100 chars

## Expected Initial State

**All tests FAIL** - this is TDD:

1. `IssueNode.test.js` fails with:
   ```
   SyntaxError: The requested module '@grafema/core' does not provide an export named 'IssueNode'
   ```

2. `NodeFactoryIssue.test.js` fails with:
   ```
   TypeError: NodeFactory.createIssue is not a function
   ```

This is the expected "red" state in TDD. Implementation follows.

## Test Patterns Discovered

From analyzing existing tests in the codebase:

1. **Test runner**: Node.js built-in (`node:test`) with `describe/it` pattern
2. **Assertions**: `node:assert` with `strictEqual`, `deepStrictEqual`, `throws`, `ok`
3. **File naming**: `.test.js` suffix, descriptive names
4. **Structure**: Tests grouped by method/feature in `describe` blocks
5. **Error patterns**: Use `assert.throws()` with regex for validation errors
6. **Node creation tests**: Verify all required fields, defaults, optional fields
7. **ID tests**: Verify format, determinism, uniqueness

## MVP Scope Notes (from 005-clarifications.md)

These tests align with MVP scope:
- No `lastSeenAt` field (removed per clarification)
- `createdAt` only for timestamp
- `reportIssue` is optional on PluginContext (backward compatible)
- Issues use existing `queryNodes()` infrastructure

## Files Changed

| File | Status | Tests |
|------|--------|-------|
| `test/unit/core/nodes/IssueNode.test.js` | NEW | 49 tests |
| `test/unit/core/NodeFactoryIssue.test.js` | NEW | 19 tests |

**Total: 68 tests**

## Next Steps

Rob Pike should implement:
1. `packages/core/src/core/nodes/IssueNode.ts` - the contract class
2. Update `packages/core/src/core/nodes/index.ts` - export IssueNode
3. Update `packages/core/src/core/NodeFactory.ts` - add createIssue method
4. Update `packages/core/src/core/nodes/NodeKind.ts` - add isIssueType helper

After implementation, run tests:
```bash
node --test test/unit/core/nodes/IssueNode.test.js
node --test test/unit/core/NodeFactoryIssue.test.js
```

All 68 tests should pass (green state).
