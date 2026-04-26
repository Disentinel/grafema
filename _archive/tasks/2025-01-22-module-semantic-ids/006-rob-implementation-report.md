# Rob Pike - Implementation Report for REG-126

## Summary

Implemented semantic IDs for MODULE nodes following the tech plan. All 24 tests pass.

## Changes Made

### 1. ModuleNode.ts (`packages/core/src/core/nodes/ModuleNode.ts`)

Added `createWithContext()` method:

```typescript
/**
 * Create MODULE node with semantic ID (NEW API)
 *
 * Uses ScopeContext for stable identifiers that don't change
 * when file content changes (unlike hash-based IDs).
 *
 * Each file has exactly one MODULE node.
 * The name in the semantic ID is always "module".
 *
 * @param context - Scope context with file path (relative to project root)
 * @param options - Optional contentHash and isTest flag
 * @returns ModuleNodeRecord with semantic ID
 */
static createWithContext(
  context: ScopeContext,
  options: ModuleContextOptions = {}
): ModuleNodeRecord {
  if (!context.file) throw new Error('ModuleNode.createWithContext: file is required in context');

  const id = computeSemanticId(this.TYPE, 'module', context);

  return {
    id,
    type: this.TYPE,
    name: context.file,
    file: context.file,
    line: 0,
    contentHash: options.contentHash || '',
    isTest: options.isTest || false
  };
}
```

Key decisions:
- Added import for `computeSemanticId` and `ScopeContext`
- Added `ModuleContextOptions` interface for the new method
- Legacy `create()` method preserved for backward compatibility
- Semantic ID format: `{file}->global->MODULE->module`

### 2. NodeFactory.ts (`packages/core/src/core/NodeFactory.ts`)

Added `createModuleWithContext()` method:

```typescript
/**
 * Create MODULE node with semantic ID (NEW API)
 *
 * Uses ScopeContext for stable identifiers.
 *
 * @param context - Scope context with file path (relative to project root)
 * @param options - Optional contentHash and isTest flag
 * @returns ModuleNodeRecord with semantic ID
 */
static createModuleWithContext(context: ScopeContext, options: ModuleContextOptions = {}) {
  return ModuleNode.createWithContext(context, options);
}
```

### 3. JSModuleIndexer.ts (`packages/core/src/plugins/indexing/JSModuleIndexer.ts`)

Updated MODULE node creation to use semantic IDs:

```typescript
// Construct MODULE node manually to preserve absolute file path for analyzers
const semanticId = `${relativePath}->global->MODULE->module`;
const moduleNode = {
  id: semanticId,
  type: 'MODULE' as const,
  name: relativePath,
  file: currentFile, // Keep absolute path for file reading in analyzers
  line: 0,
  contentHash: fileHash || '',
  isTest
};
```

**Important architectural decision:** Instead of using `NodeFactory.createModuleWithContext()`, I construct the node manually to preserve the absolute path in `file`. This is necessary because:
- `createWithContext()` sets `file` to the relative path (as tests expect)
- Analyzers like ExpressAnalyzer need the absolute path to read files
- Storing absolute path in `file` and relative path in `name` allows both use cases

Updated DEPENDS_ON edge creation:
```typescript
const depRelativePath = relative(projectPath, resolvedDep) || basename(resolvedDep);
const depModuleId = `${depRelativePath}->global->MODULE->module`;
```

### 4. IncrementalModuleIndexer.ts (`packages/core/src/plugins/indexing/IncrementalModuleIndexer.ts`)

Updated MODULE node creation and edge references:

```typescript
const semanticId = `${relativePath}->global->MODULE->module`;
const moduleNode: NodeRecord = {
  id: semanticId,
  type: 'MODULE',
  name: relativePath,
  file: file, // Keep absolute path
  contentHash: fileHash
};
```

```typescript
const importRelativePath = relative(projectPath, importFile);
const importSemanticId = `${importRelativePath}->global->MODULE->module`;
pendingImports.push({
  src: moduleNode.id,
  dst: importSemanticId
});
```

### 5. VersionManager.ts (`packages/core/src/core/VersionManager.ts`)

Updated `generateStableId()` for MODULE type:

```typescript
// Для MODULE - use semantic ID format with name (relative path)
if (type === 'MODULE') {
  // name stores the relative path for MODULE nodes
  return `${name}->global->MODULE->module`;
}
```

### 6. ExpressAnalyzer.ts (`packages/core/src/plugins/analysis/ExpressAnalyzer.ts`)

Updated MOUNTS edge creation to use semantic IDs:

```typescript
// Derive project root from module's absolute and relative paths
const moduleAbsPath = module.file!;
const moduleRelPath = module.name!;
const projectRoot = moduleAbsPath.endsWith(moduleRelPath)
  ? moduleAbsPath.slice(0, moduleAbsPath.length - moduleRelPath.length)
  : dirname(moduleAbsPath);

// Convert target absolute path to relative path for semantic ID
const targetRelativePath = relative(projectRoot, targetModulePath);
const targetModuleId = `${targetRelativePath}->global->MODULE->module`;
```

## Test Results

All 24 tests pass:
- createWithContext() API tests
- contentHash handling tests
- validation tests
- semantic ID stability tests
- computeSemanticId integration tests
- edge reference consistency tests
- cross-indexer consistency tests
- backward compatibility tests
- edge cases tests

## Breaking Change

This is a **BREAKING CHANGE** for existing graphs. Old hash-based MODULE IDs (`MODULE:{hash}`) are incompatible with new semantic IDs (`{path}->global->MODULE->module`).

**Before deploying:** Run `grafema db:clear` to clear the graph.

## Design Notes

### Absolute vs Relative Paths

The implementation maintains a clear distinction:
- `node.id`: Uses relative path (semantic ID format)
- `node.name`: Stores relative path (for display and ID construction)
- `node.file`: Stores absolute path in indexers (for file reading operations)

This allows:
1. Stable semantic IDs based on project-relative paths
2. Analyzers can still read files using absolute paths
3. Graph queries work consistently across different working directories

### createWithContext vs Manual Construction

The `createWithContext` method was designed for unit testing and situations where relative paths are sufficient. The indexers construct nodes manually to include the absolute path in `file`, which is needed by downstream analyzers.

This is intentional - the contract for `createWithContext` (as defined by tests) is that it works purely with relative paths, while the actual indexer usage has additional requirements.
