# Joel Spolsky's Technical Specification: REG-147

**Date:** January 23, 2026

## Summary

Update JSModuleIndexer to report parse failures as LanguageError instead of silently logging them.

## Current Behavior (Problem)

**File:** `/packages/core/src/plugins/indexing/JSModuleIndexer.ts`

**Lines 277-282:**
```typescript
if (deps instanceof Error) {
  if (!deps.message.includes('ENOENT')) {
    console.log(`[JSModuleIndexer] Error parsing ${currentFile}: ${deps.message}`);
  }
  continue;  // Silently skipped!
}
```

Errors are logged to console but never returned in `PluginResult.errors[]`.

## Implementation Steps

### Step 1: Add Import for LanguageError

**Location:** Line 13 (after NodeFactory import)

```typescript
import { LanguageError } from '../../errors/GrafemaError.js';
```

### Step 2: Add Error Collection Array

**Location:** Inside `execute()` method, after `const service = ...` (around line 218)

```typescript
// Collect parse errors to report
const parseErrors: Error[] = [];
```

### Step 3: Create LanguageError on Parse Failure

**Location:** Replace lines 277-282

**Before:**
```typescript
if (deps instanceof Error) {
  if (!deps.message.includes('ENOENT')) {
    console.log(`[JSModuleIndexer] Error parsing ${currentFile}: ${deps.message}`);
  }
  continue;
}
```

**After:**
```typescript
if (deps instanceof Error) {
  if (!deps.message.includes('ENOENT')) {
    const relativePath = relative(projectPath, currentFile) || basename(currentFile);
    const error = new LanguageError(
      `Failed to parse ${relativePath}: ${deps.message}`,
      'ERR_PARSE_FAILURE',
      {
        filePath: currentFile,
        phase: 'INDEXING',
        plugin: 'JSModuleIndexer',
      },
      'Check file syntax or ensure the file is a supported JavaScript/TypeScript file'
    );
    parseErrors.push(error);
  }
  continue;
}
```

### Step 4: Return Errors in PluginResult

**Location:** Replace lines 373-376

**Before:**
```typescript
return createSuccessResult(
  { nodes: nodesCreated, edges: edgesCreated },
  { totalModules: visited.size }
);
```

**After:**
```typescript
return {
  success: true,
  created: { nodes: nodesCreated, edges: edgesCreated },
  errors: parseErrors,
  warnings: [],
  metadata: { totalModules: visited.size },
};
```

## Test Specification

**File:** `test/unit/plugins/JSModuleIndexer.test.ts` (new file)

### Test 1: Parse errors are collected and reported

```typescript
it('collects parse errors as LanguageError', async () => {
  // Setup: Create a file with syntax error
  const badFile = join(tempDir, 'bad-syntax.js');
  writeFileSync(badFile, 'const x = {');  // Incomplete object

  const indexer = new JSModuleIndexer();
  const result = await indexer.execute({
    graph: mockGraph,
    manifest: {
      projectPath: tempDir,
      service: { id: 'test', name: 'test', path: 'bad-syntax.js' }
    }
  });

  // Verify
  expect(result.success).toBe(true);
  expect(result.errors).toHaveLength(1);
  expect(result.errors[0]).toBeInstanceOf(LanguageError);
  expect(result.errors[0].code).toBe('ERR_PARSE_FAILURE');
  expect(result.errors[0].context.filePath).toContain('bad-syntax.js');
});
```

### Test 2: ENOENT errors are not reported (silent skip)

```typescript
it('does not report ENOENT as parse error', async () => {
  // Setup: Entry that imports non-existent file
  const entryFile = join(tempDir, 'entry.js');
  writeFileSync(entryFile, 'import "./missing.js";');

  const indexer = new JSModuleIndexer();
  const result = await indexer.execute({
    graph: mockGraph,
    manifest: {
      projectPath: tempDir,
      service: { id: 'test', name: 'test', path: 'entry.js' }
    }
  });

  // Verify: No errors reported for missing files
  expect(result.errors).toHaveLength(0);
});
```

### Test 3: Multiple parse errors are collected

```typescript
it('collects multiple parse errors', async () => {
  // Setup: Entry that imports two bad files
  const entryFile = join(tempDir, 'entry.js');
  const bad1 = join(tempDir, 'bad1.js');
  const bad2 = join(tempDir, 'bad2.js');

  writeFileSync(entryFile, 'import "./bad1.js";\nimport "./bad2.js";');
  writeFileSync(bad1, 'const x = {');
  writeFileSync(bad2, 'function(');

  const indexer = new JSModuleIndexer();
  const result = await indexer.execute({
    graph: mockGraph,
    manifest: {
      projectPath: tempDir,
      service: { id: 'test', name: 'test', path: 'entry.js' }
    }
  });

  // Verify: Both errors collected
  expect(result.errors).toHaveLength(2);
  result.errors.forEach(err => {
    expect(err).toBeInstanceOf(LanguageError);
    expect(err.code).toBe('ERR_PARSE_FAILURE');
  });
});
```

## Edge Cases

1. **JSON files with syntax errors** - Currently handled at line 139-141: returns empty array for `.json` files. No change needed.

2. **ENOENT (file not found)** - Should NOT create LanguageError. This is handled by the `if (!deps.message.includes('ENOENT'))` check.

3. **Empty projects** - No errors to collect, returns empty array.

## Files Summary

| File | Action |
|------|--------|
| `packages/core/src/plugins/indexing/JSModuleIndexer.ts` | Modify (add import, error collection, manual return) |
| `test/unit/plugins/JSModuleIndexer.test.ts` | Create (new test file) |

## Verification

After implementation, run:
```bash
node --test test/unit/plugins/JSModuleIndexer.test.ts
```

Then verify errors flow to DiagnosticCollector in integration test.
