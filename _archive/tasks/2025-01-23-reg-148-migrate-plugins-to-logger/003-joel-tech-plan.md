# Joel Spolsky: REG-148 Technical Plan

## Executive Summary

**Actual Scope:** 183 console.log calls across 34 plugin files (not counting Plugin.ts fallback)

**Batching Strategy:** Group by plugin phase + count to minimize context switching and enable pattern reuse.

**Execution Time:** ~3-4 hours (Kent: 1h, Rob: 2-3h including test runs after each batch)

## Conventions

### Context Object Naming

Use consistent, clear names across all plugins:

| Data Type | Field Name | Type | Example |
|-----------|-----------|------|---------|
| File path | `file` | string | `{ file: '/src/foo.js' }` |
| Module count | `count` | number | `{ count: 42 }` |
| Time elapsed | `timeMs` or `timeSec` | number | `{ timeMs: 123 }` or `{ timeSec: 1.5 }` |
| Node/edge counts | `nodesCreated`, `edgesCreated` | number | `{ nodesCreated: 10, edgesCreated: 20 }` |
| Processing stats | structured object | object | `{ processed: 100, skipped: 5, errors: 0 }` |
| Violations/issues | structured object | object | `{ violations: 5, warnings: 2 }` |
| Progress | `current`, `total` | number | `{ current: 5, total: 10 }` |

### Log Level Rules (from Don's analysis)

**debug level** (only with --verbose):
- Per-file/module processing
- Performance timing per operation
- Internal state and progress updates
- Step-by-step iteration logs

**info level** (default output):
- Phase start/complete announcements
- Summary statistics at end
- User-relevant outcomes (nodes/edges created)
- Success/failure final status

**warn level**:
- Non-critical issues (skipped items, missing data)
- Performance concerns
- Deprecated patterns

**error level**:
- Critical failures
- Data integrity issues

### Emoji Handling

**Remove ALL emojis** from log messages. Reasons:
1. Structured logging should be parseable
2. Emojis don't belong in enterprise tools
3. Level prefix (INFO/WARN/ERROR) is sufficient

Transformation:
- `✅ Success` → `Success` (with info level)
- `❌ Failed` → `Failed` (with error level)
- `⚠️  Warning` → `Warning` (with warn level)
- `🚫 Issue` → `Issue` (with error/warn level)
- `📦/📁/🔗` etc → remove, redundant with context

### Plugin Name Prefix

**Remove `[PluginName]` prefix** from messages. Reasons:
1. Logger can be enhanced later to include plugin name automatically
2. Message should be self-descriptive without prefix
3. Reduces noise

## Batch 1: High-Count Validators (structural similarity)

### Files (59 console.log calls)

1. **EvalBanValidator.ts** (12 calls)
2. **TypeScriptDeadCodeValidator.ts** (11 calls)
3. **NodeCreationValidator.ts** (9 calls)
4. **SQLInjectionValidator.ts** (8 calls)

### Transformation Patterns

These validators follow IDENTICAL structure:
```typescript
console.log('[Validator] Starting...');           // → logger.info('Starting validation')
console.log('[Validator] Searching for X...');    // → logger.debug('Searching for X')
console.log(`[...] took ${time}ms, found ${n}`);  // → logger.debug('Search complete', { timeMs, count })
console.log('[Validator] Summary:', obj);         // → logger.info('Validation summary', obj)
console.log('[Validator] ❌ violations found:');  // → logger.info('Violations found', { count })
console.log(`  🚫 ${message}`);                   // → logger.warn('Violation', { message })
console.log('[Validator] ✅ No issues');          // → logger.info('Validation passed')
```

### Specific Line-by-Line Transformations

#### EvalBanValidator.ts

```typescript
// Line 73
console.log('[EvalBanValidator] Checking for eval/Function usage...');
// AFTER:
const logger = this.log(context);
logger.info('Starting eval/Function usage validation');

// Line 82
console.log('[EvalBanValidator] Searching for eval() calls...');
// AFTER:
logger.debug('Searching for eval() calls');

// Line 99
console.log(`[EvalBanValidator] eval() search took ${Date.now() - evalStart}ms, found ${evalCount} violations`);
// AFTER:
logger.debug('eval() search complete', { timeMs: Date.now() - evalStart, count: evalCount });

// Line 102
console.log('[EvalBanValidator] Searching for Function() calls...');
// AFTER:
logger.debug('Searching for Function() calls');

// Line 119
console.log(`[EvalBanValidator] Function() search took ${Date.now() - funcStart}ms, found ${funcCount} violations`);
// AFTER:
logger.debug('Function() search complete', { timeMs: Date.now() - funcStart, count: funcCount });

// Line 123
console.log('[EvalBanValidator] Searching for method eval() calls...');
// AFTER:
logger.debug('Searching for method eval() calls');

// Line 144
console.log(`[EvalBanValidator] method eval() search took ${Date.now() - methodStart}ms, found ${methodCount} violations`);
// AFTER:
logger.debug('Method eval() search complete', { timeMs: Date.now() - methodStart, count: methodCount });

// Line 147
console.log('[EvalBanValidator] Skipping aliased eval detection (requires optimized implementation)');
// AFTER:
logger.debug('Skipping aliased eval detection', { reason: 'requires optimized implementation' });

// Line 159
console.log('[EvalBanValidator] Summary:', summary);
// AFTER:
logger.info('Validation summary', summary);

// Lines 162-164
console.log('[EvalBanValidator] ❌ Security violations found:');
for (const issue of issues) {
  console.log(`  🚫 ${issue.message}`);
}
// AFTER:
logger.info('Security violations found', { count: issues.length });
for (const issue of issues) {
  logger.warn('Violation', { message: issue.message, type: issue.type, file: issue.file, line: issue.line });
}

// Line 167
console.log('[EvalBanValidator] ✅ No eval/Function usage detected');
// AFTER:
logger.info('Validation passed: no eval/Function usage detected');
```

#### TypeScriptDeadCodeValidator.ts

```typescript
// Line 62
console.log('[TypeScriptDeadCodeValidator] Checking for dead TypeScript code...');
// AFTER:
const logger = this.log(context);
logger.info('Starting dead code validation');

// Line 68
console.log('[TypeScriptDeadCodeValidator] Collecting interfaces...');
// AFTER:
logger.debug('Collecting interfaces');

// Line 83
console.log(`[TypeScriptDeadCodeValidator] Found ${interfaces.size} interfaces`);
// AFTER:
logger.debug('Interfaces collected', { count: interfaces.size });

// Line 86
console.log('[TypeScriptDeadCodeValidator] Checking implementations...');
// AFTER:
logger.debug('Checking implementations');

// Line 171
console.log('[TypeScriptDeadCodeValidator] Summary:', summary);
// AFTER:
logger.info('Validation summary', summary);

// Lines 178-180
console.log(`[TypeScriptDeadCodeValidator] ⚠️  ${warnings.length} warning(s):`);
for (const issue of warnings) {
  console.log(`  ⚠️  ${issue.message}`);
}
// AFTER:
if (warnings.length > 0) {
  logger.warn('Validation warnings', { count: warnings.length });
  for (const issue of warnings) {
    logger.warn('Warning', { message: issue.message });
  }
}

// Lines 185-190
console.log(`[TypeScriptDeadCodeValidator] ℹ️  ${infos.length} info(s):`);
for (const issue of infos) {
  console.log(`  ℹ️  ${issue.message}`);
}
if (infos.length > 5) {
  console.log(`  ... and ${infos.length - 5} more`);
}
// AFTER:
if (infos.length > 0) {
  logger.info('Validation info messages', { count: infos.length });
  const displayCount = Math.min(5, infos.length);
  for (let i = 0; i < displayCount; i++) {
    logger.info('Info', { message: infos[i].message });
  }
  if (infos.length > 5) {
    logger.info('Additional info messages', { remaining: infos.length - 5 });
  }
}

// Line 195
console.log('[TypeScriptDeadCodeValidator] ✅ No dead TypeScript code detected');
// AFTER:
logger.info('Validation passed: no dead code detected');
```

#### NodeCreationValidator.ts

```typescript
// Line 120
console.log('[NodeCreationValidator] Checking NodeFactory usage...');
// AFTER:
const logger = this.log(context);
logger.info('Starting NodeFactory usage validation');

// Line 132
console.log('[NodeCreationValidator] Graph does not support getAllEdges/getAllNodes, skipping validation');
// AFTER:
logger.warn('Validation skipped', { reason: 'Graph does not support getAllEdges/getAllNodes' });

// Line 155
console.log('[NodeCreationValidator] Searching for addNode/addNodes calls...');
// AFTER:
logger.debug('Searching for addNode/addNodes calls');

// Line 208
console.log('[NodeCreationValidator] Summary:', summary);
// AFTER:
logger.info('Validation summary', summary);

// Lines 211-217
console.log('[NodeCreationValidator] ❌ NodeFactory violations found:');
for (const issue of issues.slice(0, 10)) {
  console.log(`  🚫 [${issue.type}] ${issue.message}`);
  console.log(`     Suggestion: ${issue.suggestion}`);
}
if (issues.length > 10) {
  console.log(`  ... and ${issues.length - 10} more violations`);
}
// AFTER:
logger.info('Violations found', { count: issues.length });
const displayCount = Math.min(10, issues.length);
for (let i = 0; i < displayCount; i++) {
  const issue = issues[i];
  logger.warn('Violation', {
    type: issue.type,
    message: issue.message,
    suggestion: issue.suggestion,
    file: issue.file,
    line: issue.line
  });
}
if (issues.length > 10) {
  logger.info('Additional violations', { remaining: issues.length - 10 });
}

// Line 220
console.log('[NodeCreationValidator] ✅ All nodes created through NodeFactory');
// AFTER:
logger.info('Validation passed: all nodes created through NodeFactory');
```

#### SQLInjectionValidator.ts

```typescript
// Line 116
console.log('[SQLInjectionValidator] Checking for SQL injection vulnerabilities...');
// AFTER:
const logger = this.log(context);
logger.info('Starting SQL injection vulnerability check');

// Line 130
console.log(`[SQLInjectionValidator] Found ${sqlCalls.length} potential SQL calls`);
// AFTER:
logger.debug('SQL calls collected', { count: sqlCalls.length });

// Line 163
console.log('[SQLInjectionValidator] Summary:', summary);
// AFTER:
logger.info('Validation summary', summary);

// Lines 166-168
console.log('[SQLInjectionValidator] ❌ SQL injection vulnerabilities found:');
for (const issue of issues) {
  console.log(`  🚫 ${issue.message}`);
}
// AFTER:
logger.info('Vulnerabilities found', { count: issues.length });
for (const issue of issues) {
  logger.error('SQL injection vulnerability', {
    message: issue.message,
    type: issue.type,
    file: issue.file,
    line: issue.line
  });
}

// Line 171
console.log('[SQLInjectionValidator] ✅ No SQL injection vulnerabilities detected');
// AFTER:
logger.info('Validation passed: no SQL injection vulnerabilities detected');

// Line 319
console.log('[SQLInjectionValidator] Graph does not support checkGuarantee, skipping pattern-based check');
// AFTER:
logger.debug('Pattern-based check skipped', { reason: 'Graph does not support checkGuarantee' });

// Line 356
console.log('[SQLInjectionValidator] Datalog check skipped:', (err as Error).message);
// AFTER:
logger.debug('Datalog check skipped', { reason: (err as Error).message });
```

### Test Coverage for Batch 1

Kent should write tests that:
1. Verify `--quiet` suppresses all output from these validators
2. Verify `--verbose` shows debug-level search progress
3. Verify default mode shows only info-level summaries
4. Verify structured context objects are passed correctly
5. Spot-check one validator (EvalBanValidator) with actual graph data

---

## Batch 2: Medium-Count Validators (7 calls each)

### Files (21 console.log calls)

1. **GraphConnectivityValidator.ts** (7 calls)
2. **DataFlowValidator.ts** (7 calls)
3. **CallResolverValidator.ts** (7 calls)

### Transformation Patterns

Similar to Batch 1 but simpler structure. Follow same emoji removal and level mapping.

#### GraphConnectivityValidator.ts

```typescript
// Line 65
console.log('[GraphConnectivityValidator] Starting connectivity validation...');
// AFTER:
const logger = this.log(context);
logger.info('Starting connectivity validation');

// Line 69
console.log(`[GraphConnectivityValidator] Total nodes: ${allNodes.length}`);
// AFTER:
logger.debug('Node count', { total: allNodes.length });

// Line 74
console.log(`[GraphConnectivityValidator] Root nodes: ${rootNodes.length}`);
// AFTER:
logger.debug('Root nodes identified', { count: rootNodes.length });

// Line 83
console.log('[GraphConnectivityValidator] Graph does not support getAllEdges, skipping validation');
// AFTER:
logger.warn('Validation skipped', { reason: 'Graph does not support getAllEdges' });

// Line 89
console.log(`[GraphConnectivityValidator] Total edges: ${allEdges.length}`);
// AFTER:
logger.debug('Edge count', { total: allEdges.length });

// Line 187
console.log('[GraphConnectivityValidator] ✅ All nodes are reachable from root nodes');
// AFTER:
logger.info('Validation passed: all nodes are reachable from root nodes');

// Line 194
console.log(`[GraphConnectivityValidator] Validation complete: ${reachable.size}/${allNodes.length} nodes reachable`);
// AFTER:
logger.info('Validation complete', { reachable: reachable.size, total: allNodes.length });
```

#### DataFlowValidator.ts

```typescript
// Line 76
console.log('[DataFlowValidator] Starting data flow validation...');
// AFTER:
const logger = this.log(context);
logger.info('Starting data flow validation');

// Line 80
console.log('[DataFlowValidator] Graph does not support getAllEdges, skipping validation');
// AFTER:
logger.warn('Validation skipped', { reason: 'Graph does not support getAllEdges' });

// Line 92
console.log(`[DataFlowValidator] Found ${variables.length} variables to validate`);
// AFTER:
logger.debug('Variables collected', { count: variables.length });

// Line 170
console.log('[DataFlowValidator] Summary:', summary);
// AFTER:
logger.info('Validation summary', summary);

// Lines 174-177
console.log(`[DataFlowValidator] Found ${issues.length} issues:`);
for (const issue of issues) {
  const level = issue.severity === 'ERROR' ? '❌' : '⚠️';
  console.log(`  ${level} [${issue.type}] ${issue.message}`);
}
// AFTER:
if (issues.length > 0) {
  logger.info('Issues found', { count: issues.length });
  for (const issue of issues) {
    if (issue.severity === 'ERROR') {
      logger.error('Data flow issue', { type: issue.type, message: issue.message });
    } else {
      logger.warn('Data flow issue', { type: issue.type, message: issue.message });
    }
  }
}
```

#### CallResolverValidator.ts

```typescript
// Line 74
console.log('[CallResolverValidator] Starting call resolution validation using Datalog...');
// AFTER:
const logger = this.log(context);
logger.info('Starting call resolution validation using Datalog');

// Line 78
console.log('[CallResolverValidator] Graph does not support checkGuarantee, skipping validation');
// AFTER:
logger.warn('Validation skipped', { reason: 'Graph does not support checkGuarantee' });

// Line 91
console.log(`[CallResolverValidator] Found ${violations.length} unresolved function calls`);
// AFTER:
logger.debug('Unresolved calls found', { count: violations.length });

// Line 124
console.log('[CallResolverValidator] Summary:', summary);
// AFTER:
logger.info('Validation summary', summary);

// Lines 127-132
console.log(`[CallResolverValidator] Unresolved calls:`);
for (const issue of issues.slice(0, 10)) {
  console.log(`  ⚠️ ${issue.message}`);
}
if (issues.length > 10) {
  console.log(`  ... and ${issues.length - 10} more`);
}
// AFTER:
if (issues.length > 0) {
  logger.warn('Unresolved calls', { count: issues.length });
  const displayCount = Math.min(10, issues.length);
  for (let i = 0; i < displayCount; i++) {
    logger.warn('Unresolved call', { message: issues[i].message });
  }
  if (issues.length > 10) {
    logger.info('Additional unresolved calls', { remaining: issues.length - 10 });
  }
}
```

### Test Coverage for Batch 2

Tests should verify same patterns as Batch 1 for consistency.

---

## Batch 3: Low-Count Validators (5 calls)

### Files (5 console.log calls)

1. **ShadowingDetector.ts** (5 calls)

### Transformation Patterns

#### ShadowingDetector.ts

```typescript
// Line 74
console.log('[ShadowingDetector] Checking for variable shadowing...');
// AFTER:
const logger = this.log(context);
logger.info('Starting shadowing detection');

// Line 157
console.log('[ShadowingDetector] Summary:', summary);
// AFTER:
logger.info('Detection summary', summary);

// Lines 160-162
console.log('[ShadowingDetector] Shadowing issues found:');
for (const issue of issues) {
  console.log(`  ${issue.type === 'CROSS_FILE_SHADOW' ? '📁' : '🔒'} ${issue.message}`);
}
// AFTER:
if (issues.length > 0) {
  logger.warn('Shadowing issues found', { count: issues.length });
  for (const issue of issues) {
    logger.warn('Shadowing issue', { type: issue.type, message: issue.message });
  }
}

// Line 165
console.log('[ShadowingDetector] No shadowing issues detected');
// AFTER:
logger.info('Detection passed: no shadowing issues detected');
```

---

## Batch 4: Indexers (high complexity, many logs)

### Files (24 console.log calls)

1. **JSModuleIndexer.ts** (11 calls)
2. **IncrementalModuleIndexer.ts** (7 calls)
3. **RustModuleIndexer.ts** (3 calls)
4. **ServiceDetector.ts** (3 calls)

### Transformation Patterns

#### JSModuleIndexer.ts

```typescript
// Line 236
console.log(`[JSModuleIndexer] Building dependency tree from ${service.name}`);
// AFTER:
const logger = this.log(context);
logger.info('Building dependency tree', { service: service.name });

// Line 270
console.log(`[JSModuleIndexer] Processing: ${currentFile.replace(projectPath, '')} (depth ${depth})`);
// AFTER:
logger.debug('Processing file', { file: currentFile.replace(projectPath, ''), depth });

// Line 273
console.log(`[JSModuleIndexer] Max depth ${MAX_DEPTH} reached at ${currentFile}`);
// AFTER:
logger.debug('Max depth reached', { maxDepth: MAX_DEPTH, file: currentFile });

// Line 279
console.log(`[JSModuleIndexer] Found ${deps instanceof Error ? 0 : deps.length} dependencies in ${currentFile.replace(projectPath, '')}`);
// AFTER:
logger.debug('Dependencies found', {
  count: deps instanceof Error ? 0 : deps.length,
  file: currentFile.replace(projectPath, '')
});

// Line 295
console.log(`[JSModuleIndexer] Error parsing ${currentFile}: ${deps.message}`);
// AFTER:
logger.warn('Parsing error', { file: currentFile, error: deps.message });

// Line 318
console.log(`[JSModuleIndexer] Creating MODULE node: ${moduleNode.id}`);
// AFTER:
logger.debug('Creating MODULE node', { id: moduleNode.id });

// Line 333
console.log(`[JSModuleIndexer]   Skipping npm package: ${dep}`);
// AFTER:
logger.debug('Skipping npm package', { package: dep });

// Line 338
console.log(`[JSModuleIndexer]   Resolved: ${dep} -> ${resolvedDep.replace(projectPath, '')}`);
// AFTER:
logger.debug('Dependency resolved', { from: dep, to: resolvedDep.replace(projectPath, '') });

// Line 344
console.log(`[JSModuleIndexer]   Added to stack (depth ${depth + 1})`);
// AFTER:
logger.debug('Added to processing stack', { depth: depth + 1 });

// Line 346
console.log(`[JSModuleIndexer]   Already visited, skipping`);
// AFTER:
logger.debug('Already visited, skipping');

// Line 387
console.log(`[JSModuleIndexer] ${service.name}: ${nodesCreated} modules, ${visited.size} total in tree`);
// AFTER:
logger.info('Dependency tree built', {
  service: service.name,
  nodesCreated,
  totalInTree: visited.size
});
```

#### IncrementalModuleIndexer.ts

```typescript
// Line 178
console.log(`📦 Starting incremental indexing from: ${relative(projectPath, entryFile)}\n`);
// AFTER:
const logger = this.log(context);
logger.info('Starting incremental indexing', { entryFile: relative(projectPath, entryFile) });

// Line 261
console.log(`\r   ✅ Indexed ${processed.size} modules\n`);
// AFTER:
logger.info('Modules indexed', { count: processed.size });

// Line 262
console.log(`   📥 Parsed ${totalImportsParsed} import specifiers (unresolved: ${unresolvedImports})`);
// AFTER:
logger.info('Import specifiers parsed', {
  totalParsed: totalImportsParsed,
  unresolved: unresolvedImports
});

// Line 263
console.log(`   🔗 Pending IMPORTS edges to create: ${pendingImports.length}\n`);
// AFTER:
logger.debug('Pending IMPORTS edges', { count: pendingImports.length });

// Line 264
console.log(`   📊 Creating IMPORTS edges...\n`);
// AFTER:
logger.debug('Creating IMPORTS edges');

// Line 277
console.log(`   📊 Created ${nodesCreated} MODULE nodes and ${edgesCreated} edges`);
// AFTER:
logger.info('Indexing complete', { nodesCreated, edgesCreated });

// Line 278
console.log(`   📈 IMPORTS edges created: ${pendingImports.length}\n`);
// AFTER:
logger.info('IMPORTS edges created', { count: pendingImports.length });
```

#### RustModuleIndexer.ts

```typescript
// Line 105
console.log('[RustModuleIndexer] rust-engine/src not found, skipping');
// AFTER:
const logger = this.log(context);
logger.warn('Rust source not found, skipping', { path: 'rust-engine/src' });

// Line 112
console.log(`[RustModuleIndexer] Found ${rsFiles.length} .rs files`);
// AFTER:
logger.debug('Rust files found', { count: rsFiles.length });

// Line 157
console.log(`[RustModuleIndexer] Indexed ${nodesCreated} Rust modules`);
// AFTER:
logger.info('Rust modules indexed', { count: nodesCreated });
```

#### ServiceDetector.ts

```typescript
// Line 63
console.log(`[${this.name}] Detecting services in: ${projectPath}`);
// AFTER:
const logger = this.log(context);
logger.info('Detecting services', { path: projectPath });

// Line 100-101
console.log(`[${this.name}] Detected ${services.length} services`);
services.forEach(s => console.log(`  - ${s.name} (${s.path})`));
// AFTER:
logger.info('Services detected', { count: services.length });
services.forEach(s => logger.debug('Service found', { name: s.name, path: s.path }));
```

### Test Coverage for Batch 4

Tests should verify verbose output shows per-file processing logs.

---

## Batch 5: Enrichment Plugins (high value)

### Files (36 console.log calls)

1. **MethodCallResolver.ts** (8 calls)
2. **ValueDomainAnalyzer.ts** (7 calls)
3. **PrefixEvaluator.ts** (6 calls)
4. **ImportExportLinker.ts** (5 calls)
5. **RustFFIEnricher.ts** (5 calls)
6. **AliasTracker.ts** (4 calls)
7. **HTTPConnectionEnricher.ts** (4 calls)
8. **MountPointResolver.ts** (2 calls)

### Transformation Patterns

Follow same conventions. Key insight: enrichment plugins have progress logs (debug) and summary stats (info).

#### MethodCallResolver.ts (detailed example)

```typescript
// Line 52
console.log('[MethodCallResolver] Starting method call resolution...');
// AFTER:
const logger = this.log(context);
logger.info('Starting method call resolution');

// Line 67
console.log(`[MethodCallResolver] Found ${methodCalls.length} method calls to resolve`);
// AFTER:
logger.debug('Method calls collected', { count: methodCalls.length });

// Line 71
console.log(`[MethodCallResolver] Indexed ${classMethodIndex.size} classes`);
// AFTER:
logger.debug('Classes indexed', { count: classMethodIndex.size });

// Line 97
console.log(`[MethodCallResolver] Progress: ${methodCallsProcessed}/${methodCalls.length} (${elapsed}s, avg ${avgTime}ms/call)`);
// AFTER:
logger.debug('Resolution progress', {
  current: methodCallsProcessed,
  total: methodCalls.length,
  elapsed,
  avgTimeMs: avgTime
});

// Line 138
console.log('[MethodCallResolver] Summary:', summary);
// AFTER:
logger.info('Resolution summary', summary);

// Line 154
console.log(`[MethodCallResolver] Indexing classes: ${classCount}...`);
// AFTER:
logger.debug('Indexing classes', { count: classCount });

// Line 183
console.log(`[MethodCallResolver] Indexed ${index.size} class entries in ${totalTime}s`);
// AFTER:
logger.debug('Class indexing complete', { count: index.size, timeSec: totalTime });

// Line 205
console.log(`[MethodCallResolver] Built variable type index: ${index.size} entries in ${elapsed}s`);
// AFTER:
logger.debug('Variable type index built', { count: index.size, timeSec: elapsed });
```

#### ValueDomainAnalyzer.ts

```typescript
// Line 168
console.log('[ValueDomainAnalyzer] Starting value domain analysis...');
// AFTER:
const logger = this.log(context);
logger.info('Starting value domain analysis');

// Line 186
console.log(`[ValueDomainAnalyzer] Found ${computedCalls.length} computed member calls`);
// AFTER:
logger.debug('Computed member calls found', { count: computedCalls.length });

// Line 254
console.log('[ValueDomainAnalyzer] Resolving computed property mutations...');
// AFTER:
logger.debug('Resolving computed property mutations');

// Line 256
console.log('[ValueDomainAnalyzer] Mutation resolution stats:', mutationStats);
// AFTER:
logger.debug('Mutation resolution stats', mutationStats);

// Line 267
console.log('[ValueDomainAnalyzer] Summary:', summary);
// AFTER:
logger.info('Analysis summary', summary);

// Line 304
console.log(`[ValueDomainAnalyzer] No variable found for ${variableName} in ${file}`);
// AFTER:
logger.debug('Variable not found', { variableName, file });

// Line 309
console.log(`[ValueDomainAnalyzer] Found ${variables.length} variable(s) for ${variableName}`);
// AFTER:
logger.debug('Variables found', { variableName, count: variables.length });
```

#### Other Enrichment Plugins (abbreviated - follow same pattern)

Apply same transformation logic to:
- PrefixEvaluator.ts (6 calls)
- ImportExportLinker.ts (5 calls)
- RustFFIEnricher.ts (5 calls)
- AliasTracker.ts (4 calls)
- HTTPConnectionEnricher.ts (4 calls)
- MountPointResolver.ts (2 calls)

**Pattern:**
- Phase start → `info`
- Per-item processing → `debug`
- Stats/counts → `debug`
- Final summary → `info`
- Warnings/skips → `warn`

---

## Batch 6: Analysis Plugins (15 calls, complex)

### Files (31 console.log calls)

1. **IncrementalAnalysisPlugin.ts** (15 calls - highest complexity)
2. **JSASTAnalyzer.ts** (7 calls)
3. **RustAnalyzer.ts** (4 calls)
4. **SystemDbAnalyzer.ts** (3 calls)
5. **ExpressRouteAnalyzer.ts** (3 calls)
6. **FetchAnalyzer.ts** (3 calls)
7. **DatabaseAnalyzer.ts** (3 calls)
8. **SocketIOAnalyzer.ts** (3 calls)
9. **ServiceLayerAnalyzer.ts** (3 calls)

### Transformation Patterns

#### IncrementalAnalysisPlugin.ts (most complex)

```typescript
// Line 98
console.log('[IncrementalAnalysis] No VCS detected, skipping incremental analysis');
// AFTER:
const logger = this.log(context);
logger.warn('VCS not detected, skipping incremental analysis');

// Line 100
console.log(`[IncrementalAnalysis] Using VCS: ${this.vcsPlugin.metadata.name}`);
// AFTER:
logger.info('VCS detected', { vcs: this.vcsPlugin.metadata.name });

// Line 124
console.log('[IncrementalAnalysis] No uncommitted changes detected');
// AFTER:
logger.info('No uncommitted changes detected');

// Lines 136-137
console.log(
  `[IncrementalAnalysis] Found ${changedFiles.size} uncommitted JavaScript file(s):\n` +
  Array.from(changedFiles).map(f => `  - ${f.path} (${f.status})`).join('\n')
);
// AFTER:
logger.info('Uncommitted JavaScript files found', { count: changedFiles.size });
for (const f of changedFiles) {
  logger.debug('Changed file', { path: f.path, status: f.status });
}

// Line 147
console.log('[IncrementalAnalysis] No JavaScript files changed');
// AFTER:
logger.info('No JavaScript files changed');

// Lines 157-158
console.log(
  `[IncrementalAnalysis] Changed files that are not indexed:\n` +
  Array.from(notIndexed).map(f => `  - ${f}`).join('\n')
);
// AFTER:
logger.warn('Changed files not indexed', { count: notIndexed.size });
for (const f of notIndexed) {
  logger.debug('Not indexed', { file: f });
}

// Lines 176-177
console.log(
  `[IncrementalAnalysis] Processing ${changedInGraph.length} changed files already in graph:\n` +
  changedInGraph.map(f => `  - ${f.path} (${f.status})`).join('\n')
);
// AFTER:
logger.info('Processing changed files', { count: changedInGraph.length });
for (const f of changedInGraph) {
  logger.debug('Processing file', { path: f.path, status: f.status });
}

// Line 205
console.log(`[IncrementalAnalysis] Processing ${relativePath} (${status})`);
// AFTER:
logger.debug('Processing file', { path: relativePath, status });

// Line 209
console.log(`  → File deleted, keeping main version only`);
// AFTER:
logger.debug('File deleted, keeping main version only');

// Line 218
console.log(
  `  → Comparing:\n` +
  `      Main: ${mainNodes.map(n => `${n.type}:${n.name}`).join(', ')}\n` +
  `      New:  ${newNodes.map(n => `${n.type}:${n.name}`).join(', ')}`
);
// AFTER:
logger.debug('Comparing versions', {
  mainNodes: mainNodes.map(n => `${n.type}:${n.name}`),
  newNodes: newNodes.map(n => `${n.type}:${n.name}`)
});

// Line 243
console.log(`  → Parsed ${newNodes.length} nodes from new content`);
// AFTER:
logger.debug('Parsed new content', { nodesCount: newNodes.length });

// Line 254
console.log(`  → Found ${mainTopLevel.length} existing main nodes`);
// AFTER:
logger.debug('Existing main nodes', { count: mainTopLevel.length });

// Line 259
console.log(
  `  → Enriching ${newNodes.length} new nodes:\n` +
  newNodes.map(n => `      ${n.type}:${n.name}`).join('\n')
);
// AFTER:
logger.debug('Enriching new nodes', { count: newNodes.length });
for (const n of newNodes) {
  logger.trace('Enriching node', { type: n.type, name: n.name });
}

// Line 283
console.log(`    [REPLACES] ${newNode.name}: ${enrichedNode.id} → ${mainNodeId}`);
// AFTER:
logger.debug('Node replacement', {
  name: newNode.name,
  from: enrichedNode.id,
  to: mainNodeId
});

// Line 514
console.log(`  → Reanalyzed ${nodes.length} nodes, created ${edgesCreated} edges`);
// AFTER:
logger.debug('Reanalysis complete', { nodesCount: nodes.length, edgesCreated });
```

#### JSASTAnalyzer.ts

```typescript
// Line 283
console.log(`[JSASTAnalyzer] Starting analysis of ${modulesToAnalyze.length} modules (${skippedCount} cached)...`);
// AFTER:
const logger = this.log(context);
logger.info('Starting module analysis', {
  toAnalyze: modulesToAnalyze.length,
  cached: skippedCount
});

// Line 286
console.log(`[JSASTAnalyzer] All modules are up-to-date, skipping analysis`);
// AFTER:
logger.info('All modules up-to-date, skipping analysis');

// Line 337
console.log(`[JSASTAnalyzer] Progress: ${completed}/${modulesToAnalyze.length}`);
// AFTER:
logger.debug('Analysis progress', {
  completed,
  total: modulesToAnalyze.length
});

// Line 365-366
console.log(`[JSASTAnalyzer] Analyzed ${modulesToAnalyze.length} modules, created ${nodesCreated} nodes`);
console.log(`[JSASTAnalyzer] Stats:`, stats);
// AFTER:
logger.info('Analysis complete', {
  modulesAnalyzed: modulesToAnalyze.length,
  nodesCreated
});
logger.info('Analysis stats', stats);

// Line 403
console.log(`[JSASTAnalyzer] Starting parallel parsing with ${workerCount} workers...`);
// AFTER:
logger.debug('Starting parallel parsing', { workerCount });

// Line 463
console.log(`[JSASTAnalyzer] Parallel parsing complete: ${nodesCreated} nodes, ${edgesCreated} edges, ${errors} errors`);
// AFTER:
logger.info('Parallel parsing complete', { nodesCreated, edgesCreated, errors });
```

#### Other Analysis Plugins (abbreviated)

Apply same pattern to:
- RustAnalyzer.ts (4 calls)
- SystemDbAnalyzer.ts (3 calls)
- ExpressRouteAnalyzer.ts (3 calls)
- FetchAnalyzer.ts (3 calls)
- DatabaseAnalyzer.ts (3 calls)
- SocketIOAnalyzer.ts (3 calls)
- ServiceLayerAnalyzer.ts (3 calls)

---

## Batch 7: Miscellaneous (low count)

### Files (6 console.log calls)

1. **MonorepoServiceDiscovery.ts** (2 calls)
2. **ExpressAnalyzer.ts** (1 call)
3. **SQLiteAnalyzer.ts** (1 call)
4. **ReactAnalyzer.ts** (1 call)

### Transformation Patterns

#### MonorepoServiceDiscovery.ts

```typescript
// Line 63
console.log(`[MonorepoServiceDiscovery] Looking for services in: ${servicesPath}`);
// AFTER:
const logger = this.log(context);
logger.debug('Looking for services', { path: servicesPath });

// Line 74
console.log(`[MonorepoServiceDiscovery] Found ${entries.length} entries`);
// AFTER:
logger.debug('Entries found', { count: entries.length });
```

#### ExpressAnalyzer.ts

```typescript
// Line 103
console.log(`[ExpressAnalyzer] Created ${endpointsCreated} endpoints, ${mountPointsCreated} mount points`);
// AFTER:
const logger = this.log(context);
logger.info('Express analysis complete', { endpointsCreated, mountPointsCreated });
```

#### SQLiteAnalyzer.ts

```typescript
// Line 83
console.log(`[SQLiteAnalyzer] Found ${queriesCreated} queries, ${operationsCreated} operations`);
// AFTER:
const logger = this.log(context);
logger.info('SQLite analysis complete', { queriesCreated, operationsCreated });
```

#### ReactAnalyzer.ts

```typescript
// Line 259
console.log(`[ReactAnalyzer] Found ${stats.components} components, ${stats.hooks} hooks, ${stats.events} events, ${stats.issues} issues`);
// AFTER:
const logger = this.log(context);
logger.info('React analysis complete', stats);
```

---

## Batch 8: Special Cases (AST utilities)

### Files (3 console.log calls - comments only, not actual logs)

1. **VCSPlugin.ts** (1 call - Line 163)
2. **GraphBuilder.ts** (2 calls - Lines 190, 397 - COMMENTS only)
3. **IdGenerator.ts** (1 call - Line 49 - COMMENT only)

### Transformation

#### VCSPlugin.ts

```typescript
// Line 163
console.log(`[VCS] Detected ${plugin.metadata.name}`);
// AFTER:
const logger = this.log(context);
logger.info('VCS detected', { name: plugin.metadata.name });
```

#### GraphBuilder.ts & IdGenerator.ts

**NO ACTION NEEDED** - these are comments mentioning console.log, not actual console.log calls.

Lines 190, 397 in GraphBuilder.ts:
```typescript
// 10. Buffer net:stdio and WRITES_TO edges for console.log/error
// Buffer WRITES_TO edges for console.log/error
```

Line 49 in IdGenerator.ts:
```typescript
* const callId = idGen.generate('CALL', 'console.log', file, line, col, counterRef, {
```

These are documentation/comments. **Leave them unchanged.**

---

## Test Strategy

### Unit Tests (Kent's responsibility)

**Location:** `packages/core/test/unit/logging/`

**Test files to create:**

1. **plugin-logger-integration.test.js**
   - Mock PluginContext with different log levels
   - Verify `this.log(context)` returns correct logger
   - Verify logger calls go to context.logger
   - Verify fallback logger works when context.logger is undefined

2. **quiet-flag.test.js**
   - Run Orchestrator with `--quiet` flag
   - Verify no plugin output (mock logger, assert no info/debug calls)
   - Verify errors still logged

3. **verbose-flag.test.js**
   - Run Orchestrator with `--verbose` flag
   - Verify debug logs appear
   - Verify per-file processing logs visible

4. **default-output.test.js**
   - Run Orchestrator with default settings
   - Verify info-level logs appear
   - Verify debug logs suppressed

5. **validator-output.test.js**
   - Run EvalBanValidator on test graph
   - Verify structured context objects
   - Verify emoji removal
   - Verify summary stats format

### Integration Tests

**Run after each batch:**

```bash
# From project root
node --test packages/core/test/unit/logging/
```

If tests fail → fix before next batch.

### Manual Verification

After all batches complete:

```bash
# Check no console.log remains (except Plugin.ts fallback)
grep -r "console\.log" packages/core/src/plugins --include="*.ts" | grep -v "Plugin.ts:"

# Should return empty (or only comments in GraphBuilder/IdGenerator)
```

---

## Execution Order

1. **Kent writes tests** (1 hour)
   - Create test infrastructure first
   - Tests will guide Rob's implementation

2. **Rob executes batches sequentially** (2-3 hours)
   - Batch 1: High-count validators (most value, most risk)
   - Run tests after Batch 1 ← CRITICAL CHECKPOINT
   - Batch 2: Medium-count validators
   - Batch 3: Low-count validators
   - Batch 4: Indexers
   - Batch 5: Enrichment plugins
   - Batch 6: Analysis plugins (IncrementalAnalysisPlugin is complex)
   - Batch 7: Miscellaneous
   - Batch 8: Special cases

3. **Run full test suite** after each batch
   - If tests fail → fix before next batch
   - Don't accumulate errors

4. **Final verification** (Rob)
   - Grep for remaining console.log
   - Manual smoke test: `grafema analyze packages/core --verbose`
   - Manual smoke test: `grafema analyze packages/core --quiet`

---

## Risk Mitigation

### High-Risk Items

1. **IncrementalAnalysisPlugin.ts** (15 calls, complex multi-line logs)
   - Risk: Breaking incremental analysis logic
   - Mitigation: Extra careful with this file, test thoroughly

2. **Validators with issue loops** (EvalBanValidator, etc.)
   - Risk: Logging individual issues can be noisy
   - Mitigation: Keep issue details at warn level, summary at info level

3. **Logger initialization timing**
   - Risk: Calling `this.log(context)` before context is set
   - Mitigation: Always call `this.log(context)` at start of execute() method

### Testing Checkpoints

**After Batch 1:** Run full test suite. If tests fail, STOP and debug.

**After Batch 6:** Manual smoke test with real codebase.

---

## Acceptance Criteria (from REG-148)

- [ ] No console.log in plugin files (except Plugin.ts fallback logger)
- [ ] `--quiet` fully suppresses all plugin output
- [ ] `--verbose` shows detailed per-file processing
- [ ] Structured logging with consistent context object naming
- [ ] No emojis in log output
- [ ] No plugin name prefixes in messages (message is self-descriptive)

---

## Notes for Rob

1. **Create logger at top of execute():**
   ```typescript
   async execute(context: PluginContext): Promise<PluginResult> {
     const logger = this.log(context);
     // ... rest of code
   }
   ```

2. **Extract template string variables into context objects:**
   ```typescript
   // BEFORE
   console.log(`Processing ${file}, found ${count} items`);

   // AFTER
   logger.debug('Processing file', { file, count });
   ```

3. **Convert multi-line logs into structured logs:**
   ```typescript
   // BEFORE
   console.log(`Found:\n  - item1\n  - item2`);

   // AFTER
   logger.info('Items found', { items: ['item1', 'item2'] });
   // OR
   logger.info('Items found', { count: items.length });
   items.forEach(item => logger.debug('Item', { name: item }));
   ```

4. **Match existing code style:**
   - Use existing variable names
   - Keep same code structure
   - Only change logging, nothing else

5. **If unsure about level:**
   - User cares about it → info
   - Developer/debugging → debug
   - Problem/skip → warn
   - Fatal → error

6. **Don't refactor while migrating:**
   - No "improvements" to the logic
   - No renaming variables
   - No restructuring code
   - ONLY change console.log to logger calls

---

## Time Estimate

- **Kent (tests):** 1 hour
- **Rob (implementation):**
  - Batch 1: 30 min (59 calls)
  - Batch 2: 15 min (21 calls)
  - Batch 3: 5 min (5 calls)
  - Batch 4: 20 min (24 calls)
  - Batch 5: 30 min (36 calls)
  - Batch 6: 45 min (31 calls, complex)
  - Batch 7: 10 min (6 calls)
  - Batch 8: 5 min (1 call)
  - **Total:** 2.5-3 hours

**Grand Total:** 3.5-4 hours

---

## Success Metrics

1. **Zero console.log** in plugins (except fallback)
2. **Tests pass** after each batch
3. **Manual smoke test** confirms --quiet/--verbose work
4. **Consistent message format** across all plugins
5. **Structured context objects** enable future log querying

---

**Joel's verdict:** This is mechanical work with clear patterns. Rob can execute this systematically. The key is **batch execution with testing after each batch** to catch errors early.
