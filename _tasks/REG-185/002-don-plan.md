# REG-185: Don Melton Analysis - Glob-based File Filtering

## Current Architecture Summary

### File Discovery Flow

```
User runs: grafema analyze

1. DISCOVERY Phase:
   - If config has `services:` entries -> use config-provided services (REG-174)
   - Otherwise -> run discovery plugins (SimpleProjectDiscovery default)
   - SimpleProjectDiscovery reads package.json, finds main/source field
   - Creates SERVICE node with entrypoint path

2. INDEXING Phase (JSModuleIndexer):
   - Receives entrypoint path from service metadata
   - DFS traversal: parse file -> extract imports -> resolve paths -> recurse
   - Creates MODULE nodes for each visited file
   - Creates DEPENDS_ON edges between modules
   - Stops at: npm packages, missing files, MAX_MODULES (2000), MAX_DEPTH (50)

3. ANALYSIS/ENRICHMENT/VALIDATION:
   - Works on MODULE nodes created during indexing
   - No new file discovery
```

### Key Files

| Component | File | Role |
|-----------|------|------|
| Config | `packages/core/src/config/ConfigLoader.ts` | Loads `config.yaml`, validates services |
| Orchestrator | `packages/core/src/Orchestrator.ts` | Runs phases, manages service list |
| Discovery | `packages/core/src/plugins/discovery/SimpleProjectDiscovery.ts` | Finds entrypoint from package.json |
| Indexing | `packages/core/src/plugins/indexing/JSModuleIndexer.ts` | DFS from entrypoint, creates MODULE nodes |
| Init | `packages/cli/src/commands/init.ts` | Generates config template (currently has commented-out include/exclude) |

### Test File Filtering (Current)

JSModuleIndexer has hardcoded patterns:
```typescript
const DEFAULT_TEST_PATTERNS: RegExp[] = [
  /[/\\]test[/\\]/,        // /test/
  /[/\\]tests[/\\]/,       // /tests/
  /[/\\]__tests__[/\\]/,   // /__tests__/
  /\.test\.[jt]sx?$/,      // .test.js
  /\.spec\.[jt]sx?$/,      // .spec.js
  // ...
];
```

These patterns only **mark** files as `isTest: true`, they don't **exclude** them. The indexer still creates MODULE nodes for test files if they're reachable from entrypoint.

---

## Analysis of Design Options

### Option A: Keep Entrypoint-based Only (Status Quo)

**How it works:** No change. Users can only control analysis via:
- `services:` entries in config (manual service definitions)
- `--service` flag (filter to one service)
- `--entrypoint` flag (override entrypoint)

**Pros:**
- Graph represents **actually used** code
- Follows real module dependencies
- No risk of indexing garbage (node_modules, dist, etc.)
- Simple mental model: "what the runtime sees"

**Cons:**
- **Cannot analyze dead code** - orphaned files invisible
- **Cannot analyze standalone scripts** - no import chain to them
- **Cannot analyze multiple entry points** without config
- Users expect glob patterns (init.ts shows them commented out)

**Verdict:** Acceptable for greenfield projects, **insufficient for legacy codebases** - the primary Grafema target.

---

### Option B: Pure Glob-based Discovery

**How it works:** Replace entrypoint DFS with glob expansion:
```yaml
include:
  - "src/**/*.ts"
exclude:
  - "**/*.test.ts"
```

**Pros:**
- Full control over what's analyzed
- Can find dead code
- Can analyze scripts not connected to main entrypoint
- Familiar pattern (matches tsconfig, eslint, etc.)

**Cons:**
- **Loses module graph accuracy** - no DEPENDS_ON edges
- **Will index unused files** - vendored code, generated code, etc.
- **Major architectural change** - JSModuleIndexer becomes glob expander
- **Breaks existing behavior** - current users rely on entrypoint logic

**Verdict:** **Wrong direction.** Grafema's value is the dependency graph, not just file listing. Pure glob loses the "follows imports" intelligence.

---

### Option C: Hybrid (Recommended)

**How it works:** Three modes based on config:

1. **Default (no config changes):** Current entrypoint-based behavior
2. **Explicit services:** Config `services:` already works (REG-174)
3. **Glob filtering:** Add `include`/`exclude` as **filters**, not **discovery**

**Key insight:** Globs should **filter** the DFS traversal, not replace it.

```yaml
# Example: Analyze everything from entrypoint EXCEPT test files
include:
  - "src/**/*.ts"     # Only process files under src/
exclude:
  - "**/*.test.ts"    # Skip test files during traversal
  - "**/*.spec.ts"
  - "**/node_modules/**"  # Never follow into node_modules
```

The DFS from entrypoint continues, but:
- Files matching `exclude` are skipped during traversal (no MODULE node)
- If `include` is specified, only files matching it are processed

**Pros:**
- **Preserves graph accuracy** - still follows real imports
- **Adds user control** - exclude tests, generated code, etc.
- **Backward compatible** - no config = current behavior
- **Enables dead code detection** - via `--include-all` flag that adds glob expansion

**Cons:**
- Slightly more complex than pure approaches
- Need to decide semantics: does exclude skip the file entirely, or just not create MODULE?

**Verdict:** **Best balance.** Preserves Grafema's core value (graph) while giving users control.

---

## Recommended Approach: Hybrid with Clear Semantics

### Semantic Model

```
include: "Allow files matching these patterns into the graph"
exclude: "Skip files matching these patterns, don't follow their imports"
```

When JSModuleIndexer encounters a file during DFS:
1. Check if file matches any `exclude` pattern -> SKIP entirely
2. Check if `include` is specified AND file doesn't match -> SKIP entirely
3. Otherwise -> process normally (create MODULE, follow imports)

### Behavior Matrix

| Config | Behavior |
|--------|----------|
| No include/exclude | Current behavior (DFS from entrypoint, everything) |
| Only exclude | DFS from entrypoint, skip matching files |
| Only include | DFS from entrypoint, only process matching files |
| Both | DFS from entrypoint, only process files matching include AND not matching exclude |

### Edge Cases

**Q: If a.js imports b.js, and b.js is excluded, what happens?**
A: b.js is not processed. a.js has broken import (will be reported by BrokenImportValidator).

**Q: Does exclude prevent following imports from that file?**
A: Yes. Excluded file = not processed = no imports extracted.

**Q: What about node_modules?**
A: Already skipped by JSModuleIndexer (npm packages marked as `package::name`). Glob exclude for `**/node_modules/**` is documentation, not new behavior.

---

## High-Level Change Locations

### 1. Config Schema (GrafemaConfig)

```typescript
// packages/core/src/config/ConfigLoader.ts
export interface GrafemaConfig {
  plugins: { ... };
  services: ServiceDefinition[];
  // NEW
  include?: string[];  // Glob patterns for files to process
  exclude?: string[];  // Glob patterns for files to skip
}
```

### 2. Config Validation

Add validation in `loadConfig()`:
- Patterns must be valid globs
- Warn if `include` is empty (would exclude everything)

### 3. JSModuleIndexer

```typescript
// packages/core/src/plugins/indexing/JSModuleIndexer.ts

// Add to constructor or execute():
private includePatterns?: string[];
private excludePatterns?: string[];

// Modify DFS loop:
if (this.shouldSkipFile(filePath)) {
  continue; // Don't process, don't follow imports
}

private shouldSkipFile(filePath: string): boolean {
  // If exclude matches -> skip
  if (this.excludePatterns?.some(p => minimatch(filePath, p))) {
    return true;
  }
  // If include specified and doesn't match -> skip
  if (this.includePatterns && !this.includePatterns.some(p => minimatch(filePath, p))) {
    return true;
  }
  return false;
}
```

### 4. Config Template (init.ts)

Update `generateConfigYAML()` to include uncommented patterns:
```yaml
# File filtering (optional)
# include:
#   - "src/**/*.{ts,js,tsx,jsx}"
# exclude:
#   - "**/*.test.ts"
#   - "**/*.spec.ts"
```

### 5. Dependencies

Add `minimatch` or `picomatch` for glob matching:
```bash
pnpm add minimatch -w @grafema/core
```

---

## Migration & Compatibility

### Breaking Changes: None

- No config = current behavior
- Existing configs don't have include/exclude = current behavior

### Migration Path

Users who want filtering:
1. Run `grafema init --force` to get updated template
2. Add include/exclude patterns to config.yaml
3. Run `grafema analyze --clear` to rebuild

---

## Risks & Considerations

### Risk 1: Over-filtering
Users might accidentally exclude too much and get empty graphs.

**Mitigation:** Warn if no files match include pattern. Show count of excluded files in verbose mode.

### Risk 2: Glob Performance
Large codebases might have slow glob matching.

**Mitigation:** Use `picomatch` (faster than minimatch). Compile patterns once at start.

### Risk 3: Path Format Mismatches
Globs use forward slashes, Windows paths use backslashes.

**Mitigation:** Normalize paths before matching. Use `slash` package or `path.posix`.

### Risk 4: Complex Pattern Semantics
Users might expect `.gitignore`-style negation patterns.

**Mitigation:** Document clearly that we use standard glob syntax, not gitignore. Keep it simple.

---

## Future Enhancements (Not in Scope)

1. **`--include-all` flag:** Glob expansion without entrypoint (for dead code detection)
2. **Per-service patterns:** Different include/exclude for each service
3. **Pattern presets:** `exclude: "@testing"` expands to common test patterns
4. **Config validation in `grafema check`:** Warn about patterns that don't match any files

---

## Decision

**Recommendation: Option C (Hybrid)**

Implement `include`/`exclude` as **DFS filters**, not as a replacement for entrypoint-based discovery. This:

1. Preserves Grafema's core value (accurate dependency graph)
2. Gives users control over what's analyzed
3. Is backward compatible
4. Aligns with user expectations (they see patterns in init template)
5. Supports the target use case (legacy codebases with messy file structures)

**Joel:** Please expand this into a detailed technical plan covering:
- Exact type changes for config schema
- Minimatch/picomatch integration approach
- Test file handling (migrate from hardcoded patterns to config defaults?)
- Specific test cases for edge behaviors
- Order of implementation steps
