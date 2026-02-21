# REG-393 Analysis: Directory Index Resolution

## Current State

**CRITICAL FINDING: The feature already exists in the codebase.**

The shared utility `moduleResolution.ts` (REG-320) already implements directory index resolution:

```typescript
// Lines 180-186 in packages/core/src/utils/moduleResolution.ts
// Try index files in directory
for (const indexFile of indexFiles) {
  const testPath = join(normalizedPath, indexFile);
  if (pathExists(testPath, useFilesystem, fileIndex)) {
    return testPath;
  }
}
```

JSModuleIndexer already uses this utility:

```typescript
// Line 245-247 in packages/core/src/plugins/indexing/JSModuleIndexer.ts
private resolveModulePath(path: string): string {
  return resolveModulePathUtil(path, { useFilesystem: true }) ?? path;
}
```

## The Real Problem

The issue states that `require('./defaults')` doesn't resolve to `./defaults/index.js`. But our code already supports this. There are two possible explanations:

1. **Bug in resolution order**: The algorithm might be checking extensions before checking for directory + index files
2. **The fallback breaks the feature**: Line 246 does `?? path` - if resolution fails, it returns the original path, which then gets added to the dependency tree even though the file doesn't exist

Let me trace the exact flow:

```
processFile() line 228-229:
  const dir = dirname(filePath);
  const resolved = resolve(dir, name);  // './defaults' -> '/project/lib/defaults'
  result.push(resolved);                // Add absolute path (no extension)

execute() line 402:
  const resolvedDep = this.resolveModulePath(dep);  // Tries to resolve

resolveModulePath() line 246:
  return resolveModulePathUtil(path, { useFilesystem: true }) ?? path;
  // If resolution fails, returns original path
```

## Root Cause Analysis

**The bug is in the fallback behavior.**

When `require('./defaults')` is processed:
1. `processFile()` resolves it to absolute path: `/project/lib/defaults` (line 228-229)
2. This absolute path is pushed to the dependency list (line 229)
3. Later, `resolveModulePath()` is called (line 402)
4. The utility tries to find `/project/lib/defaults.js` or `/project/lib/defaults/index.js`
5. If BOTH fail, it returns the original path `/project/lib/defaults` (the `?? path` fallback)
6. The DFS continues with this unresolved path
7. When `existsSync()` is called in `processFile()` line 178, it returns false (it's a directory, not a file)
8. The cache stores `new Error('ENOENT')` for this path
9. The entire subtree is lost

**The fallback `?? path` is the bug.** It should return `null` when resolution fails, not the original unresolved path.

## Why Tests Pass But Real Code Fails

Looking at the test file structure, tests always create actual files with extensions. They never test the case where:
- `./defaults` directory exists
- `./defaults/index.js` exists
- But `./defaults.js` does NOT exist

The tests in `moduleResolution.test.js` cover this scenario (lines 289-314), but those tests are currently skipped because the import fails.

## The Fix

**Location:** `packages/core/src/plugins/indexing/JSModuleIndexer.ts`, line 245-247

**Current code:**
```typescript
private resolveModulePath(path: string): string {
  return resolveModulePathUtil(path, { useFilesystem: true }) ?? path;
}
```

**Should be:**
```typescript
private resolveModulePath(path: string): string {
  // Don't fallback to unresolved path - if resolution fails, the file doesn't exist
  return resolveModulePathUtil(path, { useFilesystem: true }) ?? path;
}
```

Wait, this doesn't make sense. Let me re-read the code.

Actually, looking more carefully at the DFS loop (lines 308-429):

```typescript
while (stack.length > 0 && visited.size < MAX_MODULES) {
  const { file: currentFile, depth } = stack.pop()!;

  // ... skip filtering check ...

  const deps = this.processFile(currentFile, projectPath);  // Line 339

  // ... create MODULE node ...

  // Process dependencies
  for (const dep of deps) {  // Line 395
    if (dep.startsWith('package::')) continue;

    const resolvedDep = this.resolveModulePath(dep);  // Line 402

    if (!visited.has(resolvedDep)) {
      visited.add(resolvedDep);
      stack.push({ file: resolvedDep, depth: depth + 1 });  // Line 408
    }
    // ... queue DEPENDS_ON edge ...
  }
}
```

The problem is clearer now:

1. `processFile()` returns `/project/lib/defaults` (absolute path without extension)
2. `resolveModulePath()` tries to resolve it and returns the SAME path (the fallback)
3. This path is added to the stack
4. Next iteration: `processFile('/project/lib/defaults')` is called
5. Line 178: `existsSync('/project/lib/defaults')` returns `true` (directory exists!)
6. But then `readFileSync()` on line 183 throws an error (can't read directory)
7. This triggers the catch block, but since it's not a `.json` file, it stores an error
8. The subtree is lost

Actually wait - let me check if `existsSync()` returns true for directories...

Yes, `existsSync()` returns true for both files AND directories. The bug is that after checking `existsSync()`, we immediately try to `readFileSync()` without checking if it's a file vs directory.

But the resolution utility already has this check! Look at line 172-175 in moduleResolution.ts:

```typescript
if (useFilesystem && ext === '' && isDirectory(testPath, useFilesystem)) {
  // It's a directory, skip to index files
  continue;
}
```

So the utility correctly skips directories when trying the empty extension. It should then try index files.

## Let me re-analyze with concrete example

Scenario: `require('./defaults')` where directory structure is:
```
lib/
  defaults/
    index.js
```

Flow:
1. `processFile()` line 228: `resolve('/project/lib', './defaults')` → `/project/lib/defaults`
2. `result.push('/project/lib/defaults')` (line 229)
3. Later, `resolveModulePath('/project/lib/defaults')` is called
4. Utility tries extensions in order: `['', '.js', '.mjs', ...]`
5. For `''` (exact): checks `/project/lib/defaults`
   - `existsSync()` returns true (directory exists)
   - `isDirectory()` returns true
   - SKIPS this match (line 174: `continue`)
6. For `.js`: checks `/project/lib/defaults.js`
   - Doesn't exist, moves on
7. For `.mjs`, `.cjs`, etc.: all don't exist
8. Now tries index files (lines 180-186)
9. For `index.js`: checks `/project/lib/defaults/index.js`
   - This exists!
   - Returns `/project/lib/defaults/index.js`

This should work! The resolution utility should return the correct path.

## Testing Hypothesis

Let me check if maybe the problem is that the fallback happens when it shouldn't. Let me re-read line 246:

```typescript
return resolveModulePathUtil(path, { useFilesystem: true }) ?? path;
```

If `resolveModulePathUtil()` returns `null`, it falls back to `path`. This means if resolution fails, we push the unresolved path to the stack.

But the resolution utility already checks for directories! So why would it return null?

OH. I see it now. Let me trace through one more time very carefully:

The resolution utility first tries extensions on the BASE PATH. If the base path is already a directory, it correctly skips it. Then it tries index files.

But what if the directory `/project/lib/defaults/` doesn't have an `index.js`? Then the utility returns `null`. Then the fallback `?? path` kicks in and returns `/project/lib/defaults`. This gets pushed to the stack. Next iteration tries to process it, and boom - error.

So the fallback IS the bug. When resolution fails, we should NOT add the file to the stack at all.

## Wait, let me check the visited set logic

Line 406-412:
```typescript
if (!visited.has(resolvedDep)) {
  visited.add(resolvedDep);
  stack.push({ file: resolvedDep, depth: depth + 1 });
} else {
  logger.debug('Already visited, skipping', { file: resolvedDep });
}
```

The `visited` set contains `/project/lib/defaults` after the fallback. If resolution actually worked, it would contain `/project/lib/defaults/index.js`. These are different paths, so the visited check doesn't help.

## Actual Root Cause

I need to test this in real code. The resolution utility SHOULD work. But maybe:

1. There's a bug in the utility itself (unlikely, given the test coverage)
2. The utility isn't being called correctly
3. There's filesystem timing issue (unlikely)
4. The issue description is wrong and the feature actually works

Let me check if there are actual axios test cases in the repo.

Actually, re-reading the issue description:

> On axios (43-file library), this single gap causes **79% of files to be unreachable**

This is a very specific claim. This means someone actually ran Grafema on axios and measured coverage. Let me search for axios test data.

But I don't have access to that. Let me trust the issue description and assume the bug exists.

## Most Likely Scenario

The utility code is correct. The bug is NOT in the resolution algorithm. The bug is in how JSModuleIndexer uses it.

Actually, wait. Let me look at the processFile logic again. Line 226-233:

```typescript
// Resolve relative paths
if (name.startsWith('.') || name.startsWith('/')) {
  const dir = dirname(filePath);
  const resolved = resolve(dir, name);
  result.push(resolved);
} else {
  // npm package
  result.push(`package::${name}`);
}
```

This pushes the UNRESOLVED path to the result. The resolution happens LATER in the execute loop.

So the dependency list contains raw absolute paths like `/project/lib/defaults` (no extension).

Then line 402 tries to resolve these. If resolution returns null (no file found), the fallback returns the original path. This path then goes into the stack and eventually fails.

## The Actual Fix

Change line 245-247 in JSModuleIndexer.ts:

```typescript
private resolveModulePath(path: string): string {
  return resolveModulePathUtil(path, { useFilesystem: true }) ?? path;
}
```

To:

```typescript
private resolveModulePath(path: string): string | null {
  return resolveModulePathUtil(path, { useFilesystem: true });
}
```

Then in the execute loop, check for null and skip adding to stack:

```typescript
const resolvedDep = this.resolveModulePath(dep);
if (!resolvedDep) {
  // Resolution failed - file doesn't exist
  logger.debug('Could not resolve dependency', { from: currentFile, to: dep });
  continue;
}

// Add to stack if not visited
if (!visited.has(resolvedDep)) {
  visited.add(resolvedDep);
  stack.push({ file: resolvedDep, depth: depth + 1 });
}
```

But wait - this would break existing behavior. Currently, if resolution fails, we still create DEPENDS_ON edges. The edges just point to non-existent nodes.

Actually, looking at line 414-427, the edge creation happens regardless:

```typescript
// Queue DEPENDS_ON edges for later (after all nodes exist)
const depBaseRelativePath = relative(projectPath, resolvedDep) || basename(resolvedDep);
const depRelativePath = context.rootPrefix
  ? `${context.rootPrefix}/${depBaseRelativePath}`
  : depBaseRelativePath;
const depModuleId = `${depRelativePath}->global->MODULE->module`;
pendingDependsOnEdges.push({
  src: moduleId,
  dst: depModuleId,
  type: 'DEPENDS_ON',
  version: 'main'
});
```

So we create edges even if the file doesn't exist. This is probably intentional for tracking unresolved dependencies.

## Final Analysis

I think the resolution utility is correct and already supports directory index files. The problem might be:

1. The utility isn't being called for some files (bug in the flow)
2. There's a performance issue (resolution is too slow so some files timeout)
3. The issue description is based on old code that's since been fixed
4. There's a subtle bug in the resolution order

Without being able to run Grafema on actual axios code and debug it, I can't be 100% certain.

## Plan

Given the uncertainty, I'll create a test-first approach:

1. **Kent writes a test** that reproduces the axios scenario:
   - Entry file: `lib/axios.js`
   - Requires: `require('./defaults')`
   - Directory structure: `lib/defaults/index.js`
   - Expected: `defaults/index.js` should be in the graph
   - Currently: it's not (presumably)

2. **Run the test** - if it passes, the feature already works and we just need to verify on real axios

3. **If test fails**, debug to find the actual bug

4. **Fix the bug** (likely one of):
   - Remove the `?? path` fallback in resolveModulePath
   - Fix the resolution utility to try index files first
   - Fix the visited set logic to handle directories correctly

5. **Add more test coverage** for edge cases:
   - Directory without index file (should not be reachable)
   - Both `foo.js` and `foo/index.js` exist (should prefer `foo.js`)
   - Multiple index file extensions (`index.js`, `index.ts`)

## Files to Change

1. **Test first**: `test/unit/plugins/indexing/JSModuleIndexer.test.ts`
   - Add test case for directory index resolution
   - Use real file structure that mimics axios

2. **If bug exists in JSModuleIndexer**: `packages/core/src/plugins/indexing/JSModuleIndexer.ts`
   - Likely line 245-247 (remove fallback)
   - Possibly lines 402-428 (handle null resolution)

3. **If bug exists in utility**: `packages/core/src/utils/moduleResolution.ts`
   - Likely lines 167-178 (extension trial logic)
   - Possibly lines 180-186 (index file logic)

## Edge Cases to Consider

1. **Both file and directory exist**: `foo.js` and `foo/index.js`
   - Expected: prefer `foo.js` (utility already handles this via extension order)

2. **Directory without index**: `foo/` with only `foo/bar.js`
   - Expected: resolution fails, file not added to stack
   - Current behavior: unknown (need to test)

3. **Symlink to directory**: `foo -> bar/` where `bar/index.js` exists
   - Expected: should follow symlink and find index
   - Current behavior: `existsSync()` follows symlinks, so should work

4. **Circular dependencies**: `a/index.js` requires `./b`, `b/index.js` requires `../a`
   - Expected: visited set prevents infinite loop
   - Current behavior: should already work (visited set)

5. **Multiple index extensions**: `foo/index.ts` and `foo/index.js`
   - Expected: prefer `index.js` (first in DEFAULT_INDEX_FILES)
   - Current behavior: utility tries in order, should work

## Complexity Assessment

**Original issue stated: LOW complexity**

**My assessment: MEDIUM complexity**

The code structure suggests the feature should already work, but the issue claims it doesn't. This means:
- Either there's a subtle bug that's hard to spot (increased complexity)
- Or the issue description is outdated (still need to verify)

The fix itself is simple (2-5 lines), but finding the root cause requires careful debugging.

## Next Steps

1. Kent writes test that reproduces the problem
2. Run test to confirm bug exists
3. If bug exists, add debug logging to trace the resolution
4. Fix the bug (likely removing fallback or fixing resolution order)
5. Verify all existing tests still pass
6. Verify new test passes
7. Kevlin + Linus review
