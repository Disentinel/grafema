# User Request: REG-148

## Linear Issue

**REG-148: Migrate plugins to use context.logger instead of console.log**

## Description

REG-145 established Logger infrastructure in PluginContext. Now plugins need to be migrated from `console.log()` to `context.logger` for proper --quiet/--verbose support.

## Scope

~50 console.log calls across 35 plugins need migration.

### Priority Order (by console.log count)

1. **JSModuleIndexer** (11 calls) - highest impact
2. **IncrementalAnalysisPlugin** (15 calls)
3. **JSASTAnalyzer** (7 calls)
4. **Validators** (many files, few calls each)
5. **Enrichment plugins**
6. **Discovery plugins**

## Implementation Pattern

Use `this.log(context).info()` helper from Plugin base class:

```typescript
// Before
console.log(`[JSModuleIndexer] Processing: ${file}`);

// After
const logger = this.log(context);
logger.debug('Processing file', { file });
```

## Guidelines

* Per-file/per-module logs → `debug` level (only with --verbose)
* Phase summaries → `info` level
* Warnings → `warn` level
* Errors → `error` level

## Acceptance Criteria

- [ ] No console.log in plugin files
- [ ] `--quiet` fully suppresses all plugin output
- [ ] `--verbose` shows detailed per-file processing

## Dependencies

REG-145 (infrastructure complete)
