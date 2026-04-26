# REG-259: Package-Specific Analyzer Plugin Architecture (v2) — Coverage Tracking

**Date:** 2026-02-15
**Author:** Don Melton (Tech Lead)
**Version:** 2 (revised based on user feedback)

## Executive Summary

This task establishes **coverage tracking architecture** for package-specific analyzers. The core insight from user feedback:

> Auto-detection shouldn't be deferred. And it's NOT just about package.json — it's about **coverage tracking**:
> 1. Each analyzer plugin declares which packages it covers
> 2. Grafema already knows which external libraries are imported (DEPENDS_ON edges)
> 3. During VALIDATION phase — match imported packages against covered packages
> 4. Uncovered packages → create ISSUE nodes
> 5. Show warning to user: "N libraries not covered by semantic analysis"

This is **NOT** auto-activation (plugins don't auto-enable). This is **coverage reporting** — telling users what's missing.

## Current Architecture Analysis

### How External Imports Are Tracked

**JSModuleIndexer** (INDEXING phase):
- Parses `require()` and `import` statements
- External packages detected by pattern: `!name.startsWith('.') && !name.startsWith('/')`
- Stored as: `package::${name}` in dependency list (line 233 in JSModuleIndexer.ts)
- **Currently:** External packages are NOT persisted to graph — only used for DFS traversal control
- **Gap:** No EXTERNAL_MODULE nodes for external packages at indexing time

**ExternalCallResolver** (ENRICHMENT phase):
- Creates EXTERNAL_MODULE nodes when resolving CALL edges
- Node ID format: `EXTERNAL_MODULE:${packageName}` (e.g., `EXTERNAL_MODULE:sqlite3`)
- Extracts package name from IMPORT source field (line 166 in ExternalCallResolver.ts)
- **Coverage:** Only creates nodes for packages that are actually called
- **Gap:** Packages imported but not called → no EXTERNAL_MODULE node

**Example EXTERNAL_MODULE node:**
```typescript
{
  id: 'EXTERNAL_MODULE:sqlite3',
  type: 'EXTERNAL_MODULE',
  name: 'sqlite3',
  file: '',
  line: 0
}
```

### How IMPORT Nodes Work

**Created by:** JSASTAnalyzer (ANALYSIS phase)
**Fields:**
```typescript
interface ImportNode {
  id: string;              // Semantic ID
  type: 'IMPORT';
  file: string;            // File containing the import
  line: number;
  source: string;          // 'sqlite3', './utils', '@tanstack/react-query'
  importType: string;      // 'default' | 'named' | 'namespace'
  imported?: string;       // Original name in source
  local: string;           // Local binding name
}
```

**Key insight:** IMPORT nodes with non-relative `source` field = external package imports.

**Example query:**
```typescript
for await (const imp of graph.queryNodes({ nodeType: 'IMPORT' })) {
  if (imp.source && !imp.source.startsWith('.') && !imp.source.startsWith('/')) {
    // This is an external package import
    const packageName = extractPackageName(imp.source); // 'sqlite3', '@scope/pkg'
  }
}
```

### How ISSUE Nodes Work

**Created via:** `context.reportIssue()` in VALIDATION phase
**Pattern (from UnconnectedRouteValidator.ts, line 62-77):**
```typescript
if (context.reportIssue) {
  await context.reportIssue({
    category: 'connectivity',        // Issue category
    severity: 'warning',             // 'error' | 'warning' | 'info'
    message: 'Customer-facing route has no frontend consumers',
    file: route.file || '',
    line: route.line || 0,
    column: route.column || 0,
    targetNodeId: route.id,          // Creates AFFECTS edge
    context: {                       // Arbitrary metadata
      type: 'UNCONNECTED_CUSTOMER_ROUTE',
      method: 'GET',
      path: '/api/users'
    }
  });
}
```

**Creates:**
1. ISSUE node: `issue:{category}` (e.g., `issue:connectivity`, `issue:coverage`)
2. AFFECTS edge: `ISSUE -> targetNodeId` (optional, if targetNodeId provided)

**Node structure (from PhaseRunner.ts, line 143-163):**
```typescript
const node = NodeFactory.createIssue(
  issue.category,        // 'coverage'
  issue.severity,        // 'warning'
  issue.message,         // Human-readable
  pluginName,            // Which validator created it
  issue.file,
  issue.line,
  issue.column,
  { context: issue.context }
);
```

### Validation Plugin Pattern

**Phase:** VALIDATION (runs after ENRICHMENT)
**Access to:** Full graph with all nodes and edges
**Creates:** ISSUE nodes via `context.reportIssue()`
**Pattern (from UnconnectedRouteValidator.ts):**

```typescript
export class MyValidator extends Plugin {
  get metadata(): PluginMetadata {
    return {
      name: 'MyValidator',
      phase: 'VALIDATION',
      creates: {
        nodes: ['ISSUE'],        // issue:category nodes
        edges: ['AFFECTS']       // ISSUE -> target edges
      }
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    const { graph } = context;
    let issueCount = 0;

    // 1. Collect data from graph
    for await (const node of graph.queryNodes({ type: 'SOME_TYPE' })) {
      // 2. Check invariant
      if (violatesInvariant(node)) {
        // 3. Report issue
        if (context.reportIssue) {
          await context.reportIssue({
            category: 'my-category',
            severity: 'warning',
            message: 'Problem description',
            file: node.file || '',
            line: node.line || 0,
            targetNodeId: node.id
          });
          issueCount++;
        }
      }
    }

    return createSuccessResult(
      { nodes: issueCount, edges: issueCount },
      { issueCount }
    );
  }
}
```

## Coverage Tracking Architecture

### Design Overview

**Goal:** Track which external packages are used but not covered by semantic analyzers.

**Components:**
1. **Plugin Coverage Declaration** — Analyzers declare what they cover via metadata
2. **Coverage Validator** — Compares imported packages vs covered packages
3. **ISSUE Nodes** — Reports uncovered packages as `issue:coverage` nodes
4. **User Warning** — Summary report at end of analysis

### 1. Plugin Coverage Declaration

**Add `covers` field to PluginMetadata:**

```typescript
// packages/types/src/plugins.ts (line 43-58)
export interface PluginMetadata {
  name: string;
  phase: PluginPhase;
  creates?: {
    nodes?: NodeType[];
    edges?: EdgeType[];
  };
  dependencies?: string[];
  fields?: FieldDeclaration[];
  consumes?: EdgeType[];
  produces?: EdgeType[];

  // NEW: Package coverage declaration
  covers?: string[];  // npm package names this analyzer handles
}
```

**Example usage:**

```typescript
// packages/core/src/plugins/analysis/SQLiteAnalyzer.ts
export class SQLiteAnalyzer extends Plugin {
  get metadata(): PluginMetadata {
    return {
      name: 'SQLiteAnalyzer',
      phase: 'ANALYSIS',
      creates: { nodes: ['db:query'], edges: ['EXECUTES_QUERY'] },
      dependencies: ['JSModuleIndexer', 'JSASTAnalyzer'],
      covers: ['sqlite3', 'better-sqlite3']  // NEW
    };
  }
}
```

**Package name format:**
- Simple packages: `'lodash'`, `'sqlite3'`
- Scoped packages: `'@tanstack/react-query'`, `'@prisma/client'`
- Matches what appears in `import` source field and EXTERNAL_MODULE node name

**Why `covers` not `packages`?**
- Clearer intent: "this plugin covers these packages"
- Consistent with `consumes`/`produces` pattern (verbs)
- Avoids confusion with npm package.json

### 2. Coverage Validator Plugin

**New file:** `packages/core/src/plugins/validation/PackageCoverageValidator.ts`

**Responsibilities:**
1. Collect all `covers` declarations from loaded analysis plugins
2. Query graph for all external package imports (via IMPORT nodes)
3. Extract package names from import sources
4. Compare: imported packages vs covered packages
5. For each uncovered package → create ISSUE node
6. Log summary: "N packages used, M covered, K uncovered"

**Algorithm:**

```typescript
export class PackageCoverageValidator extends Plugin {
  get metadata(): PluginMetadata {
    return {
      name: 'PackageCoverageValidator',
      phase: 'VALIDATION',
      creates: {
        nodes: ['ISSUE'],    // issue:coverage nodes
        edges: ['AFFECTS']   // ISSUE -> IMPORT edges
      }
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    const { graph, config } = context;
    const logger = this.log(context);

    // STEP 1: Collect coverage declarations from all loaded plugins
    const coveredPackages = new Set<string>();
    const plugins = this.getLoadedPlugins(context);  // Get from orchestrator config

    for (const plugin of plugins) {
      const covers = plugin.metadata.covers ?? [];
      for (const pkg of covers) {
        coveredPackages.add(pkg);
      }
    }

    logger.info('Package coverage collected', {
      loadedPlugins: plugins.length,
      coveredPackages: coveredPackages.size
    });

    // STEP 2: Collect all imported external packages
    const importedPackages = new Map<string, string[]>(); // package -> files

    for await (const imp of graph.queryNodes({ nodeType: 'IMPORT' })) {
      const source = imp.source as string | undefined;
      if (!source || !imp.file) continue;

      // Skip relative imports
      if (source.startsWith('.') || source.startsWith('/')) continue;

      // Extract package name (handles scoped packages)
      const packageName = this.extractPackageName(source);
      if (!packageName) continue;

      if (!importedPackages.has(packageName)) {
        importedPackages.set(packageName, []);
      }
      importedPackages.get(packageName)!.push(imp.file as string);
    }

    logger.info('External imports collected', {
      importedPackages: importedPackages.size
    });

    // STEP 3: Find uncovered packages
    const uncoveredPackages = new Map<string, string[]>(); // package -> files

    for (const [pkg, files] of importedPackages.entries()) {
      if (!coveredPackages.has(pkg)) {
        uncoveredPackages.set(pkg, files);
      }
    }

    // STEP 4: Create ISSUE nodes for uncovered packages
    let issueCount = 0;

    for (const [pkg, files] of uncoveredPackages.entries()) {
      // Report one issue per unique file (not per import)
      const uniqueFiles = Array.from(new Set(files));

      for (const file of uniqueFiles) {
        if (context.reportIssue) {
          await context.reportIssue({
            category: 'coverage',
            severity: 'warning',
            message: `Package '${pkg}' imported but no semantic analyzer configured`,
            file: file,
            line: 0,  // Could enhance: find first import in file
            context: {
              type: 'UNCOVERED_PACKAGE',
              packageName: pkg,
              suggestion: `Add analyzer plugin for '${pkg}' to config.yaml`
            }
          });
          issueCount++;
        }
      }
    }

    // STEP 5: Summary report
    const summary = {
      importedPackages: importedPackages.size,
      coveredPackages: coveredPackages.size,
      uncoveredPackages: uncoveredPackages.size,
      issuesCreated: issueCount
    };

    if (uncoveredPackages.size > 0) {
      logger.warn('Uncovered packages detected', {
        count: uncoveredPackages.size,
        packages: Array.from(uncoveredPackages.keys())
      });
      logger.warn(
        `${uncoveredPackages.size} external packages used but not covered by semantic analysis. ` +
        `Results may be incomplete.`
      );
    } else {
      logger.info('All imported packages covered by analyzers');
    }

    return createSuccessResult(
      { nodes: issueCount, edges: issueCount },
      summary
    );
  }

  /**
   * Extract package name from import source.
   * Handles scoped packages (@scope/pkg) and subpath imports (pkg/sub).
   */
  private extractPackageName(source: string): string | null {
    if (!source) return null;

    // Scoped package: @scope/package or @scope/package/subpath
    if (source.startsWith('@')) {
      const parts = source.split('/');
      if (parts.length >= 2) {
        return `${parts[0]}/${parts[1]}`;
      }
      return null;
    }

    // Unscoped package: package or package/subpath
    const parts = source.split('/');
    return parts[0];
  }

  /**
   * Get list of loaded plugins from orchestrator config.
   * Needs access to plugin registry (implementation detail).
   */
  private getLoadedPlugins(context: PluginContext): Plugin[] {
    // Implementation note: This requires orchestrator to pass loaded plugins
    // via context. Alternative: pass via ResourceRegistry (REG-256 pattern)

    // For now, stub — will be implemented during execution phase
    return [];
  }
}
```

**Implementation challenge:** How does validator get access to loaded plugins?

**Options:**

**Option A: Via PluginContext.config**
```typescript
// Orchestrator sets loaded plugins in config
context.config.loadedPlugins = [plugin1, plugin2, ...]

// Validator reads them
const plugins = context.config.loadedPlugins ?? [];
```

**Option B: Via ResourceRegistry (REG-256 pattern)**
```typescript
// Orchestrator writes to shared resource
await context.resources.set('loadedPlugins', plugins);

// Validator reads from resource
const plugins = await context.resources.get<Plugin[]>('loadedPlugins') ?? [];
```

**Option C: Via static registry**
```typescript
// Orchestrator registers plugins globally
PluginRegistry.register(plugin);

// Validator reads from registry
const plugins = PluginRegistry.getAll();
```

**Recommendation:** Option B (ResourceRegistry) — aligns with existing cross-plugin communication pattern (REG-256), no global state.

### 3. ISSUE Node Schema

**Node type:** `issue:coverage`
**Created by:** PackageCoverageValidator
**Fields:**
```typescript
{
  id: string;              // Generated by NodeFactory
  type: 'ISSUE',
  category: 'coverage',    // Identifies this as coverage issue
  severity: 'warning',     // Not an error, just a gap
  message: "Package 'sqlite3' imported but no semantic analyzer configured",
  source: 'PackageCoverageValidator',  // Which validator created it
  file: string,            // File that imported the package
  line: number,            // 0 or first import line
  column: number,          // 0 or first import column
  metadata: {
    context: {
      type: 'UNCOVERED_PACKAGE',
      packageName: 'sqlite3',
      suggestion: "Add analyzer plugin for 'sqlite3' to config.yaml"
    }
  }
}
```

**AFFECTS edge:** Optional (could point to first IMPORT node for that package in that file)

### 4. User-Facing Warnings

**During analysis (CLI):**
```
⚠ 3 external packages used but not covered by semantic analysis:
  - sqlite3 (imported in 5 files)
  - @tanstack/react-query (imported in 12 files)
  - lodash (imported in 8 files)

Suggestion: Add semantic analyzers to config.yaml for complete analysis.
Results may be incomplete for these packages.
```

**In graph (via query):**
```typescript
// Query all coverage issues
const coverageIssues = await graph.queryNodes({
  nodeType: 'ISSUE',
  category: 'coverage'
});

// Group by package
const uncoveredPackages = new Map<string, number>();
for await (const issue of coverageIssues) {
  const pkg = issue.metadata?.context?.packageName;
  if (pkg) {
    uncoveredPackages.set(pkg, (uncoveredPackages.get(pkg) ?? 0) + 1);
  }
}
```

**MCP integration:** `check_guarantees` command could report coverage issues alongside other validators.

## Integration with Package-Specific Analyzers

### SQLiteAnalyzer Update

**Current (before this task):**
```typescript
export class SQLiteAnalyzer extends Plugin {
  get metadata(): PluginMetadata {
    return {
      name: 'SQLiteAnalyzer',
      phase: 'ANALYSIS',
      creates: { nodes: ['db:query'], edges: ['EXECUTES_QUERY'] },
      dependencies: ['JSModuleIndexer', 'JSASTAnalyzer']
    };
  }
}
```

**After (with coverage declaration):**
```typescript
export class SQLiteAnalyzer extends Plugin {
  get metadata(): PluginMetadata {
    return {
      name: 'SQLiteAnalyzer',
      phase: 'ANALYSIS',
      creates: { nodes: ['db:query'], edges: ['EXECUTES_QUERY'] },
      dependencies: ['JSModuleIndexer', 'JSASTAnalyzer'],
      covers: ['sqlite3', 'better-sqlite3']  // NEW
    };
  }
}
```

**Impact:** Zero code changes in analyzer logic. Only metadata declaration.

### Future Analyzers (REG-260+)

**When creating new package-specific analyzer:**
1. Extend `Plugin` class
2. Set `phase: 'ANALYSIS'`
3. Declare `covers: [...]` in metadata
4. Implement detection logic
5. Register in builtinPlugins.ts

**Example (PrismaAnalyzer):**
```typescript
export class PrismaAnalyzer extends Plugin {
  get metadata(): PluginMetadata {
    return {
      name: 'PrismaAnalyzer',
      phase: 'ANALYSIS',
      creates: { nodes: ['db:query'], edges: ['EXECUTES_QUERY'] },
      dependencies: ['JSModuleIndexer', 'JSASTAnalyzer'],
      covers: ['@prisma/client', 'prisma']  // Covers both runtime and CLI
    };
  }
}
```

**Coverage validator automatically picks up new analyzers** — no changes needed in validator code.

## Edge Cases & Design Questions

### Q1: Package imported but not used in code?

**Example:**
```typescript
import sqlite3 from 'sqlite3';  // Imported
// ... but never called
```

**Behavior:**
- IMPORT node exists → PackageCoverageValidator sees it
- No CALL nodes → ExternalCallResolver doesn't create EXTERNAL_MODULE node
- No `covers: ['sqlite3']` → ISSUE created

**Is this correct?** YES — we want to know about unused imports too (potential dead code).

**Alternative:** Only track packages that are actually called. Requires querying EXTERNAL_MODULE nodes instead of IMPORT nodes.

**Recommendation:** Track IMPORT nodes (current design) — catches more cases, aligns with "coverage = what's imported".

### Q2: Package imported via dynamic require?

**Example:**
```javascript
const pkg = 'sqlite3';
const db = require(pkg);  // Dynamic require
```

**Behavior:**
- JSModuleIndexer doesn't detect dynamic requires
- No IMPORT node created
- PackageCoverageValidator doesn't see it

**Is this a gap?** YES, but acceptable — dynamic imports are rare, hard to analyze statically.

**Future enhancement:** JSASTAnalyzer could create IMPORT nodes for common dynamic patterns, but out of scope for this task.

### Q3: Ecosystem collisions (npm sqlite3 vs PyPI sqlite3)?

**Current design:** Package names are ecosystem-agnostic strings (`'sqlite3'`, `'lodash'`).

**Problem:** If future Python support is added:
- `npm/sqlite3` → analyzer covers `'sqlite3'`
- `pypi/sqlite3` → analyzer covers `'sqlite3'`
- Same string, different ecosystems → collision

**Solution A: Ecosystem prefix in `covers`**
```typescript
covers: ['npm:sqlite3']  // Explicit ecosystem
```

**Solution B: Separate field**
```typescript
covers: {
  npm: ['sqlite3', 'better-sqlite3'],
  pypi: ['sqlalchemy']
}
```

**Recommendation for v0.2:** Keep simple strings, defer ecosystem namespacing to multi-language support task.

**Rationale:**
- Grafema currently only supports JavaScript/TypeScript (npm ecosystem)
- Python/Java support is v0.5+ roadmap
- No collision risk today
- When multi-language support is added, refactor `covers` to structured format

**Migration path:**
```typescript
// v0.2-v0.4 (JavaScript only)
covers: ['sqlite3']

// v0.5+ (multi-language)
covers: {
  npm: ['sqlite3'],
  pypi: ['sqlite3']  // Different package, same name
}
```

### Q4: Should `covers` be required for all analyzers?

**No.** Many analyzers don't analyze external packages:
- ExpressRouteAnalyzer — analyzes Express routes (already covered by framework import)
- JSASTAnalyzer — extracts AST structure (no package coverage)
- ReactAnalyzer — detects React patterns (covers React, but via framework detection not package)

**Rule:** Only **package-specific analyzers** declare `covers`. Framework analyzers and AST extractors don't need it.

**Example of analyzer WITHOUT `covers`:**
```typescript
export class ExpressRouteAnalyzer extends Plugin {
  get metadata(): PluginMetadata {
    return {
      name: 'ExpressRouteAnalyzer',
      phase: 'ANALYSIS',
      creates: { nodes: ['http:route'], edges: ['ROUTES_TO'] },
      // No 'covers' — this is a framework analyzer, not package-specific
    };
  }
}
```

### Q5: What if user configures analyzer but package not imported?

**Example:**
- Config: `plugins.analysis: ['SQLiteAnalyzer']`
- Code: No `import 'sqlite3'` anywhere

**Behavior:**
- SQLiteAnalyzer runs, finds nothing, returns 0 nodes/edges
- PackageCoverageValidator sees `covers: ['sqlite3']` but no imports of `'sqlite3'`
- **No issue created** — coverage is fine, package just not used

**Is this wasteful?** Slightly (analyzer runs unnecessarily), but not a problem:
- Analyzers are fast when no matches found
- No false positives (no issue created)
- User preference to over-configure is fine

**Future optimization:** Config validator could warn "SQLiteAnalyzer configured but sqlite3 not in package.json", but out of scope.

## Implementation Plan

### Phase 1: Type Changes (PluginMetadata)

**File:** `packages/types/src/plugins.ts`

**Change:** Add `covers?: string[]` to PluginMetadata interface (line 43-58)

```typescript
export interface PluginMetadata {
  name: string;
  phase: PluginPhase;
  creates?: { nodes?: NodeType[]; edges?: EdgeType[] };
  dependencies?: string[];
  fields?: FieldDeclaration[];
  consumes?: EdgeType[];
  produces?: EdgeType[];

  /**
   * Package names this analyzer covers (for coverage tracking).
   * Only used by package-specific analyzers.
   * Examples: ['sqlite3'], ['@prisma/client'], ['lodash']
   */
  covers?: string[];
}
```

**Tests:** Update PluginMetadata tests to accept `covers` field.

### Phase 2: Coverage Validator Plugin

**File:** `packages/core/src/plugins/validation/PackageCoverageValidator.ts` (new)

**Structure:**
1. Collect `covers` from loaded plugins (via ResourceRegistry)
2. Query IMPORT nodes for external packages
3. Extract package names (handle scoped packages)
4. Compare imported vs covered
5. Create ISSUE nodes for uncovered packages
6. Log summary

**Dependencies:**
- Needs access to loaded plugins → requires Orchestrator change (Phase 3)

### Phase 3: Orchestrator Changes

**File:** `packages/core/src/Orchestrator.ts` or `packages/core/src/PhaseRunner.ts`

**Change:** Store loaded plugins in ResourceRegistry before running VALIDATION phase.

```typescript
// After loading all plugins, before running phases
await context.resources.set('loadedPlugins', this.plugins);
```

**Alternative:** Add `loadedPlugins` to PluginContext (simpler, but less aligned with REG-256 pattern).

### Phase 4: Update Existing Analyzers

**Files to update:**
- `packages/core/src/plugins/analysis/SQLiteAnalyzer.ts` — add `covers: ['sqlite3', 'better-sqlite3']`
- Future analyzers (PrismaAnalyzer, etc.) — add `covers` at creation time

**Tests:** Verify `covers` field present in metadata.

### Phase 5: CLI Warning Integration

**File:** `packages/cli/src/commands/analyze.ts`

**Enhancement:** After analysis completes, query `issue:coverage` nodes and print summary.

```typescript
// After orchestrator.run()
const coverageIssues = await graph.queryNodes({
  nodeType: 'ISSUE',
  category: 'coverage'
});

const uncoveredPackages = new Map<string, number>();
for await (const issue of coverageIssues) {
  const pkg = issue.metadata?.context?.packageName;
  if (pkg) {
    uncoveredPackages.set(pkg, (uncoveredPackages.get(pkg) ?? 0) + 1);
  }
}

if (uncoveredPackages.size > 0) {
  console.warn(
    `⚠ ${uncoveredPackages.size} external packages not covered by semantic analysis:`
  );
  for (const [pkg, count] of uncoveredPackages) {
    console.warn(`  - ${pkg} (imported in ${count} files)`);
  }
  console.warn('Results may be incomplete. Add analyzers to config.yaml.');
}
```

### Phase 6: Registration & Config

**File:** `packages/cli/src/plugins/builtinPlugins.ts`

**Add:**
```typescript
import { PackageCoverageValidator } from '@grafema/core';

export const BUILTIN_PLUGINS = {
  // ... existing
  PackageCoverageValidator: () => new PackageCoverageValidator() as Plugin,
};
```

**File:** `packages/core/src/config/ConfigLoader.ts`

**Update DEFAULT_CONFIG:**
```typescript
const DEFAULT_CONFIG = {
  plugins: {
    // ... existing phases
    validation: [
      'AwaitInLoopValidator',
      'SQLInjectionValidator',
      'PackageCoverageValidator',  // NEW
    ]
  }
};
```

**Auto-enabled by default** — users don't need to configure it explicitly.

### Phase 7: Documentation

**File:** `_readme/package-analyzers.md` (new)

**Content:**
- What is coverage tracking?
- How to read coverage warnings
- How to add package-specific analyzers
- List of built-in analyzers and what they cover

**File:** `_readme/plugin-development.md`

**Update:** Document `covers` field in PluginMetadata for plugin authors.

## Scope Estimate

**Files to create:**
- `packages/core/src/plugins/validation/PackageCoverageValidator.ts` (~200 LOC)
- `test/unit/plugins/validation/PackageCoverageValidator.test.ts` (~150 LOC)
- `_readme/package-analyzers.md` (~100 LOC)

**Files to modify:**
- `packages/types/src/plugins.ts` (+10 LOC, add `covers` field)
- `packages/core/src/Orchestrator.ts` or `PhaseRunner.ts` (+5 LOC, set loadedPlugins in resources)
- `packages/core/src/plugins/analysis/SQLiteAnalyzer.ts` (+1 LOC, add `covers`)
- `packages/cli/src/plugins/builtinPlugins.ts` (+2 LOC, register validator)
- `packages/core/src/config/ConfigLoader.ts` (+1 LOC, add to DEFAULT_CONFIG)
- `packages/cli/src/commands/analyze.ts` (+20 LOC, coverage summary)

**Total LOC:** ~490 lines (200 validator + 150 tests + 100 docs + 40 integration)

**Risk:** LOW-MEDIUM
- New validation plugin (well-understood pattern)
- Minimal changes to existing code
- ResourceRegistry usage (proven in REG-256)
- Main risk: Orchestrator integration (how to pass loaded plugins to validator)

**Time estimate:** 4-6 hours (1-2 for validator, 1-2 for integration, 1-2 for tests/docs)

## Architecture Validation

### Complexity Check

**PackageCoverageValidator iteration space:**
1. **Collect coverage:** O(p) where p = loaded plugins (typically 10-20)
2. **Collect imports:** O(i) where i = IMPORT nodes (typically 100-500)
3. **Compare:** O(m) where m = unique package names (typically 10-50)
4. **Create issues:** O(u) where u = uncovered packages (typically 0-10)

**Total:** O(p + i + m + u) — linear in all inputs ✓

**NOT a brute-force scan** — queries specific node types (IMPORT), no full graph traversal.

**Grafema doesn't brute-force.** ✓

### Plugin Architecture Check

**Uses existing abstractions:**
- ✓ Validation plugin pattern (UnconnectedRouteValidator precedent)
- ✓ `context.reportIssue()` API (proven in multiple validators)
- ✓ ResourceRegistry for cross-plugin data (REG-256 pattern)
- ✓ ISSUE nodes for reporting (existing pattern)

**No new iteration:** Reuses IMPORT node query (already exists in graph).

**Forward registration:** Plugins declare `covers` → validator reads declarations. Not backward pattern scanning.

**Extensibility:** Adding new analyzer = add `covers` to metadata. Validator auto-picks it up. ✓

**Grafema architecture compliance:** ✓

## Answers to All Design Questions

### Original Questions (from user request):

**Q1: How are external packages currently represented in the graph?**

**A:** Two mechanisms:
1. **IMPORT nodes** (from JSASTAnalyzer) — every `import`/`require` statement creates IMPORT node with `source` field
2. **EXTERNAL_MODULE nodes** (from ExternalCallResolver) — created when external function is called

**Node type:** IMPORT (for all imports), EXTERNAL_MODULE (for called packages only)
**Edge type:** No DEPENDS_ON edges to external packages currently — only between internal MODULE nodes

### Q2: Can we distinguish `import sqlite3` from `import ./localModule`?

**A:** YES — via `source` field:
- External: `source: 'sqlite3'` (no `.` or `/` prefix)
- Relative: `source: './localModule'` (starts with `.` or `/`)

Pattern (line 78 in ExternalCallResolver.ts):
```typescript
const isRelative = imp.source.startsWith('./') || imp.source.startsWith('../');
if (isRelative) continue;  // Skip local modules
```

### Q3: What's the existing ISSUE node pattern?

**A:** Created via `context.reportIssue()` in VALIDATION phase:
- Validator calls `context.reportIssue({ category, severity, message, file, line, targetNodeId })`
- PhaseRunner creates ISSUE node via NodeFactory.createIssue()
- Optional AFFECTS edge to targetNodeId
- See UnconnectedRouteValidator.ts (line 62-77) for reference implementation

### Q4: Should `covers` be simple string array or more structured?

**A:** Simple string array for v0.2 (JavaScript-only):
```typescript
covers: ['sqlite3', 'better-sqlite3', '@prisma/client']
```

**Rationale:**
- No ecosystem collisions today (only npm packages)
- Easy to implement and use
- Migration path exists for multi-language support (v0.5+)

**Future (v0.5+):** Structured format for multi-language:
```typescript
covers: {
  npm: ['sqlite3'],
  pypi: ['sqlalchemy'],
  maven: ['org.postgresql:postgresql']
}
```

### Q5: How does this interact with ecosystem question (npm vs pypi vs maven)?

**A:** Deferred to multi-language support task (v0.5+).

**Current scope (v0.2):**
- Grafema only analyzes JavaScript/TypeScript → npm ecosystem only
- Package names are unqualified strings (`'sqlite3'`)
- No ecosystem prefix needed
- When Python/Java support added, refactor `covers` to structured format

**Not a blocker for this task.**

### New Questions (coverage tracking specific):

**Q6: Should coverage validator run by default?**

**A:** YES — add to DEFAULT_CONFIG.plugins.validation.

**Rationale:**
- Zero cost when all packages covered (no issues created)
- High value when gaps exist (warns user about incomplete analysis)
- No configuration needed (auto-enabled)

### Q7: What if analyzer covers package but plugin not loaded?

**Example:** SQLiteAnalyzer has `covers: ['sqlite3']` but not in config.

**A:** Coverage validator only sees loaded plugins.
- If SQLiteAnalyzer not loaded → `covers: ['sqlite3']` not collected
- If code imports `'sqlite3'` → ISSUE created (uncovered)
- **Expected behavior** — user should add SQLiteAnalyzer to config

### Q8: Should we track EXTERNAL_MODULE nodes or IMPORT nodes?

**A:** IMPORT nodes (current design).

**Comparison:**

| Approach | Pros | Cons |
|----------|------|------|
| IMPORT nodes | Tracks all imports (used or not) | May report unused imports |
| EXTERNAL_MODULE nodes | Only tracks actually-called packages | Misses imported-but-not-called packages |

**Decision:** IMPORT nodes — more complete coverage, aligns with "what's imported" not "what's called".

**User can filter out unused imports** via separate dead code detector (future).

## Deliverable for REG-259

**Architectural design approved** — answers all questions, defines:
1. Plugin coverage declaration (`covers` field in PluginMetadata)
2. Coverage validator pattern (PackageCoverageValidator)
3. ISSUE node schema for uncovered packages
4. User-facing warnings (CLI summary)
5. Integration plan (ResourceRegistry, DEFAULT_CONFIG)

**Implementation work** — belongs in separate task (create as follow-up if approved).

**Unblocks:** REG-260 (SQLiteAnalyzer) and future package-specific analyzers — all should declare `covers` in metadata.

## Next Steps

1. **Get user approval** on coverage tracking architecture
2. **If approved** → create implementation task (or fold into REG-259 if user prefers)
3. **Implementation task includes:**
   - Phase 1-7 from Implementation Plan
   - Tests for PackageCoverageValidator
   - Update SQLiteAnalyzer with `covers` field
   - CLI warning integration

## Open Questions

**Q: How should Orchestrator pass loaded plugins to validator?**

**Options:**
- A) Via ResourceRegistry: `context.resources.set('loadedPlugins', plugins)` (recommended)
- B) Via PluginContext.config: `context.config.loadedPlugins = plugins`
- C) Via static registry (avoid — global state)

**Recommendation:** Option A (ResourceRegistry) — aligns with REG-256 cross-plugin communication pattern.

**User decision needed:** Confirm ResourceRegistry approach or suggest alternative.

---

**Summary:** Coverage tracking architecture is well-defined, follows existing patterns (ISSUE nodes, validation plugin, ResourceRegistry), provides immediate value (warns about incomplete analysis), and has clear extension path. Ready for approval and implementation.
