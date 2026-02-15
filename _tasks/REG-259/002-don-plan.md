# REG-259: Package-Specific Analyzer Plugin Architecture — Plan

**Date:** 2026-02-15
**Author:** Don Melton (Tech Lead)

## Executive Summary

Current `DatabaseAnalyzer` is too abstract — detects only generic `db.query()`/`db.execute()` patterns that don't match real-world npm packages. Each database library has its own API:
- `npm/sqlite3`: `db.run()`, `db.get()`, `db.all()`
- `npm/prisma`: `prisma.user.create()`, `prisma.$queryRaw()`
- `npm/pg`: `pool.query()`, `client.query()`
- `maven/jdbc`: `statement.executeQuery()`, `preparedStatement.executeUpdate()`

This task establishes the plugin architecture for package-specific analyzers. REG-260 (blocked by this) will implement the first concrete analyzer (`npm/sqlite3`).

## Current Architecture Analysis

### Plugin System Overview

**Plugin Loading (CLI layer):**
- Built-in plugins: `packages/cli/src/plugins/builtinPlugins.ts` — factory registry mapping names to classes
- Custom plugins: `.grafema/plugins/*.js` — loaded via `pluginLoader.ts`, registered via ESM resolve hook
- Config: `.grafema/config.yaml` — lists plugin names by phase

**Plugin Contract:**
```typescript
// packages/core/src/plugins/Plugin.ts
abstract class Plugin {
  abstract get metadata(): PluginMetadata;  // name, phase, creates, dependencies
  abstract execute(context: PluginContext): Promise<PluginResult>;
  async initialize(context: PluginContext): Promise<void>;  // optional
  async cleanup(): Promise<void>;  // optional
}
```

**Phases:** DISCOVERY → INDEXING → ANALYSIS → ENRICHMENT → VALIDATION

**Plugin Metadata:**
```typescript
interface PluginMetadata {
  name: string;
  phase: 'DISCOVERY' | 'INDEXING' | 'ANALYSIS' | 'ENRICHMENT' | 'VALIDATION';
  creates?: { nodes?: string[]; edges?: string[] };
  dependencies?: string[];  // plugin names this depends on
  fields?: FieldDeclaration[];  // metadata fields for RFDB indexing
}
```

### Current Database Analyzers

**1. DatabaseAnalyzer (abstract/generic):**
- File: `packages/core/src/plugins/analysis/DatabaseAnalyzer.ts`
- Detects: `db.query()`, `connection.execute()`, `pool.query()`
- Creates: `db:query`, `db:table`, `db:connection` nodes
- Edges: `MAKES_QUERY`, `TARGETS`, `READS_FROM`, `WRITES_TO`
- Problem: Hardcoded method names don't match real packages

**2. SQLiteAnalyzer (package-specific, exists!):**
- File: `packages/core/src/plugins/analysis/SQLiteAnalyzer.ts`
- Detects: `database.getDb().all()`, `db.get()`, `db.run()`, Promise-wrapped patterns
- Creates: `db:query` nodes with SQLite-specific metadata
- **This is already a package-specific analyzer!**
- **Gap:** Not organized under package registry pattern, mixes detection logic

### Framework Analyzer Pattern (Prior Art)

**ExpressAnalyzer:**
- File: `packages/core/src/plugins/analysis/ExpressAnalyzer.ts`
- Detects: `app.get()`, `router.use()`, `app.post()`
- Creates: `http:route`, `express:mount` nodes
- Pattern: Single file, framework-specific, no package registry

**Observation:** Framework analyzers (Express, NestJS, SocketIO) follow same pattern — single file per framework, registered in `builtinPlugins.ts`. Package analyzers should follow similar structure.

## Design Decisions

### 1. Plugin Naming & Directory Structure

**Question:** `npm-sqlite3` vs `npm/sqlite3` directory structure?

**Decision:** Flat naming, filesystem-based organization for custom plugins.

**Rationale:**
- Plugin class names use flat naming: `Sqlite3Analyzer`, `PrismaAnalyzer`, `JDBCAnalyzer`
- Config references use flat names: `plugins.analysis: ['Sqlite3Analyzer']`
- Custom plugins directory already uses flat files: `.grafema/plugins/MyCustomAnalyzer.js`
- Directory structure is NOT exposed in config — internal organization only

**Structure:**
```
packages/core/src/plugins/analysis/
  DatabaseAnalyzer.ts              # Keep as fallback (deprecated, document)
  SQLiteAnalyzer.ts                # ALREADY EXISTS, rename → Sqlite3Analyzer.ts
  PrismaAnalyzer.ts                # Future (REG-260+)
  PostgresAnalyzer.ts              # Future
  SequelizeAnalyzer.ts             # Future
  JDBCAnalyzer.ts                  # Future (Java/Maven)
  SQLAlchemyAnalyzer.ts            # Future (Python/PyPI)
```

**For custom plugins:**
```
.grafema/plugins/
  Sqlite3Analyzer.js               # Copy of built-in (if user wants to customize)
  MyCustomDbAnalyzer.js            # User's own package-specific analyzer
```

**Registry naming convention (internal):**
- npm packages: `{PackageName}Analyzer` (e.g., `Sqlite3Analyzer`, `PrismaAnalyzer`)
- Maven artifacts: `{ArtifactName}Analyzer` (e.g., `JDBCAnalyzer`, `HikariCPAnalyzer`)
- PyPI packages: `{PackageName}Analyzer` (e.g., `SQLAlchemyAnalyzer`)
- No prefix needed — package name is self-documenting

### 2. Config Syntax

**Question:** How to enable in config.yaml?

**Decision:** Explicit plugin names in config, auto-detection via **separate mechanism**.

**Config format (existing pattern, no changes):**
```yaml
plugins:
  analysis:
    - JSASTAnalyzer
    - ExpressRouteAnalyzer
    - Sqlite3Analyzer          # Package-specific analyzer
    - PrismaAnalyzer            # Another package-specific analyzer
    - DatabaseAnalyzer          # Fallback (deprecated but kept for compat)
```

**Why no special section?**
- Existing analyzers (Express, NestJS, SocketIO) already work this way
- No need for `packages:` section — plugin names are sufficient
- Config loader already handles this (`packages/core/src/config/ConfigLoader.ts`)

### 3. Auto-Detection Strategy

**Question:** Should plugins auto-activate based on package.json dependencies?

**Decision:** NO auto-activation in v0.2. Explicit config only.

**Rationale:**
1. **Principle of least surprise:** Users should know what runs
2. **Performance:** Auto-scanning package.json dependencies across all services adds overhead
3. **False positives:** package.json may list deps not actually used
4. **Config is already manual:** Users already configure plugins explicitly
5. **Future enhancement:** Can add auto-detection in v0.3 as opt-in feature

**What we SHOULD provide:**
- `grafema init` command enhancement (future): scan package.json, suggest plugins
- Documentation: "If you use sqlite3, add `Sqlite3Analyzer` to config.yaml"
- Error message: If `db.run()` detected but no analyzer configured, suggest adding `Sqlite3Analyzer`

**Auto-detection implementation (deferred to v0.3):**
```yaml
# Future syntax (v0.3+)
plugins:
  analysis:
    autoDetect: true           # Scan package.json, auto-enable analyzers
    # OR explicit override:
    - Sqlite3Analyzer
    - PrismaAnalyzer
```

### 4. DatabaseAnalyzer Deprecation

**Question:** Remove abstract DatabaseAnalyzer or keep as fallback?

**Decision:** **Keep as deprecated fallback** with clear documentation.

**Rationale:**
1. **Backward compatibility:** Existing configs reference it
2. **Graceful migration:** Projects can migrate incrementally
3. **Fallback coverage:** Catches patterns not covered by package-specific analyzers
4. **Low cost:** Doesn't add complexity, just one more plugin

**Migration plan:**
1. v0.2: Mark DatabaseAnalyzer as deprecated in metadata, add warning log
2. v0.2: Update DEFAULT_CONFIG to replace DatabaseAnalyzer with package-specific analyzers
3. v0.3: Remove from DEFAULT_CONFIG (users who want it must explicitly list it)
4. v0.5+: Remove entirely (breaking change, documented in migration guide)

**Deprecation marker:**
```typescript
export class DatabaseAnalyzer extends Plugin {
  get metadata(): PluginMetadata {
    return {
      name: 'DatabaseAnalyzer',
      phase: 'ANALYSIS',
      deprecated: true,  // NEW FIELD (add to PluginMetadata interface)
      deprecationMessage: 'Use package-specific analyzers (Sqlite3Analyzer, PrismaAnalyzer, etc.) instead. ' +
                          'DatabaseAnalyzer will be removed in v0.5.',
      // ... rest
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    context.logger.warn('DatabaseAnalyzer is deprecated. Use Sqlite3Analyzer, PrismaAnalyzer, etc. instead.');
    // ... existing logic
  }
}
```

## Plugin Interface Design

### Base Package Analyzer Pattern

**NOT creating a separate base class** — package-specific analyzers extend `Plugin` directly, same as framework analyzers (Express, NestJS).

**Common pattern (not enforced by interface):**
1. Parse MODULE nodes (provided by JSModuleIndexer)
2. Use Babel to traverse AST
3. Detect package-specific patterns (method calls, object properties)
4. Create `db:query` or equivalent nodes
5. Link to parent FUNCTION via `MAKES_QUERY` or `EXECUTES_QUERY` edge

**Example plugin structure (Sqlite3Analyzer already follows this):**
```typescript
export class Sqlite3Analyzer extends Plugin {
  get metadata(): PluginMetadata {
    return {
      name: 'Sqlite3Analyzer',
      phase: 'ANALYSIS',
      creates: {
        nodes: ['db:query'],
        edges: ['CONTAINS', 'EXECUTES_QUERY']
      },
      dependencies: ['JSModuleIndexer', 'JSASTAnalyzer']  // Needs MODULE and FUNCTION nodes
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    const modules = await this.getModules(context.graph);

    for (const module of modules) {
      await this.analyzeModule(module, context.graph, context.manifest.projectPath);
    }

    return createSuccessResult({ nodes: ..., edges: ... });
  }

  private async analyzeModule(module: NodeRecord, graph: GraphBackend, projectPath: string) {
    // 1. Read and parse file with Babel
    // 2. Traverse AST looking for sqlite3-specific patterns
    // 3. Create db:query nodes
    // 4. Link to containing FUNCTION
  }
}
```

### Node Schema

**Reuse existing `db:query` node type** (created by DatabaseAnalyzer, already in graph).

**Fields (from NodeFactory.createSQLiteQuery):**
```typescript
{
  id: string;           // Semantic ID
  type: 'db:query';
  file: string;
  line: number;
  name: string;         // Method name (e.g., 'get', 'run', 'all')
  query?: string;       // SQL query string
  operation?: string;   // 'SELECT', 'INSERT', 'UPDATE', etc.
  metadata?: {
    method: string;         // sqlite3 method ('get', 'all', 'run')
    params?: string;        // Extracted params
    tableName?: string;     // Extracted from SQL
    promiseWrapped?: boolean;
    package: string;        // NEW: 'sqlite3', 'prisma', 'pg', etc.
  }
}
```

**NEW field: `metadata.package`** — identifies which package this query came from.

**Why not separate node types per package?**
- Database operations are semantically identical (read/write data)
- Validators (SQLInjectionValidator) work across all packages
- Package info is in metadata, queryable via Datalog

### Registration & Loading

**Built-in plugins:**
1. Add to `packages/core/src/index.ts` exports:
   ```typescript
   export { Sqlite3Analyzer } from './plugins/analysis/Sqlite3Analyzer.js';
   export { PrismaAnalyzer } from './plugins/analysis/PrismaAnalyzer.js';
   ```

2. Add to `packages/cli/src/plugins/builtinPlugins.ts`:
   ```typescript
   import { Sqlite3Analyzer, PrismaAnalyzer } from '@grafema/core';

   export const BUILTIN_PLUGINS: Record<string, () => Plugin> = {
     // ... existing
     Sqlite3Analyzer: () => new Sqlite3Analyzer() as Plugin,
     PrismaAnalyzer: () => new PrismaAnalyzer() as Plugin,
   };
   ```

3. Reference in config:
   ```yaml
   plugins:
     analysis:
       - Sqlite3Analyzer
   ```

**Custom plugins:**
1. User writes `.grafema/plugins/MyDbAnalyzer.js`:
   ```javascript
   import { Plugin, createSuccessResult } from '@grafema/core';

   export default class MyDbAnalyzer extends Plugin {
     get metadata() {
       return {
         name: 'MyDbAnalyzer',
         phase: 'ANALYSIS',
         creates: { nodes: ['db:query'], edges: ['EXECUTES_QUERY'] },
         dependencies: ['JSASTAnalyzer']
       };
     }

     async execute(context) {
       // ... custom detection logic
       return createSuccessResult({ nodes: 0, edges: 0 });
     }
   }
   ```

2. Reference in config:
   ```yaml
   plugins:
     analysis:
       - MyDbAnalyzer
   ```

3. CLI auto-loads from `.grafema/plugins/` (via `pluginLoader.ts`)

**No plugin registry class needed** — existing `BUILTIN_PLUGINS` object + `loadCustomPlugins()` function is sufficient.

## Implementation Plan

### Files to Create/Modify

**1. Rename SQLiteAnalyzer → Sqlite3Analyzer**
- `packages/core/src/plugins/analysis/SQLiteAnalyzer.ts` → `Sqlite3Analyzer.ts`
- Update class name, metadata.name
- Add `metadata.package: 'sqlite3'` to created nodes
- Update exports in `packages/core/src/index.ts`
- Update `builtinPlugins.ts`

**2. Mark DatabaseAnalyzer as deprecated**
- Add `deprecated: true`, `deprecationMessage` to metadata
- Add `PluginMetadata.deprecated?: boolean` to types
- Add `PluginMetadata.deprecationMessage?: string` to types
- Add warning log in execute()

**3. Update DEFAULT_CONFIG**
- `packages/core/src/config/ConfigLoader.ts`
- Replace `DatabaseAnalyzer` with `Sqlite3Analyzer` in DEFAULT_CONFIG.plugins.analysis

**4. Update PluginMetadata interface (types)**
- `packages/types/src/plugins.ts`
- Add optional fields:
  ```typescript
  interface PluginMetadata {
    // ... existing
    deprecated?: boolean;
    deprecationMessage?: string;
  }
  ```

**5. Update tests**
- Rename test files: `SQLiteAnalyzer.test.ts` → `Sqlite3Analyzer.test.ts`
- Update imports and class references
- Add deprecation warning check for DatabaseAnalyzer tests

**6. Documentation**
- Update `_readme/` with package-specific analyzer guide
- Document naming conventions
- Add examples for custom package analyzers
- Migration guide for DatabaseAnalyzer → package-specific

### Scope Estimate

**Files to modify:** ~8 files
- Core: 3 files (rename SQLiteAnalyzer, update DatabaseAnalyzer, types)
- CLI: 1 file (builtinPlugins.ts)
- Config: 1 file (DEFAULT_CONFIG)
- Tests: 2-3 test files
- Docs: 1 README

**LOC changes:** ~150 lines
- Rename/update: ~50 lines (metadata, exports)
- Deprecation: ~30 lines (types, warning logic)
- Config: ~10 lines (DEFAULT_CONFIG change)
- Tests: ~60 lines (rename, deprecation checks)

**Risk:** LOW
- No new abstractions, just organizing existing pattern
- SQLiteAnalyzer already works, just needs renaming
- Backward compatible (DatabaseAnalyzer kept)

## Architecture Validation

### Prior Art Search Results

From WebSearch query on "plugin architecture package-specific analyzers ESLint SonarQube Semgrep 2026":

**Key Patterns:**
1. **ESLint:** Plugin-per-package model (`eslint-plugin-sonarjs`, `eslint-plugin-react`)
   - Flat namespace, plugins register explicitly
   - No auto-detection, users add to config

2. **SonarQube:** Language-specific analyzers + rule plugins
   - SonarJS = analyzer for JavaScript/TypeScript
   - Plugins extend rules, not core detection

3. **Semgrep:** Rule-based, not plugin-based
   - Rules describe patterns, single engine runs them
   - Different model (declarative vs imperative)

**Grafema's approach aligns with ESLint pattern:**
- Explicit plugin registration in config
- Flat namespace (no `packages/` prefix)
- Plugin-per-package granularity
- Built-in + custom plugin support

**Sources:**
- [GitHub - SonarSource/eslint-plugin-sonarjs](https://github.com/SonarSource/eslint-plugin-sonarjs)
- [eslint-plugin-sonarjs - npm](https://www.npmjs.com/package/eslint-plugin-sonarjs)
- [GitHub - SonarSource/SonarJS](https://github.com/SonarSource/SonarJS)

### Complexity Check

**Iteration space:** O(m) where m = MODULE nodes (typically 100-1000)

**Per-module:** O(n) where n = AST nodes in that module (typically 100-500)

**Total:** O(m × n) = O(modules × nodes-per-module)

**Critical insight:** This is THE SAME complexity as JSASTAnalyzer, ExpressAnalyzer, etc. — all analyzers iterate modules and traverse AST.

**NOT a brute-force scan** — analyzers only process MODULE nodes created by JSModuleIndexer (which uses DFS from entry points). No "scan all files looking for patterns" — forward registration via indexing phase.

**Grafema doesn't brute-force.** ✓

### Extensibility Check

**Adding new package support:**
1. Write new analyzer class (e.g., `PrismaAnalyzer.ts`)
2. Export from `@grafema/core`
3. Add to `builtinPlugins.ts`
4. Users add to config.yaml

**No changes to:**
- Plugin base class
- Plugin loading system
- Config schema
- Orchestrator

**Extending existing enricher pass:** N/A — analyzers run in ANALYSIS phase (per-module), not ENRICHMENT (global).

**Plugin architecture:** ✓ Minimal coupling, clean extension points.

## Answers to Design Questions

### 1. Plugin naming: `npm-sqlite3` vs `npm/sqlite3` directory structure?

**Answer:** Flat naming, no prefix. `Sqlite3Analyzer`, not `NpmSqlite3Analyzer`.

**Rationale:**
- Package name is self-documenting (`sqlite3` = npm, `JDBC` = Maven)
- Matches existing framework analyzers (ExpressAnalyzer, not NpmExpressAnalyzer)
- Config references: `Sqlite3Analyzer` (clean, readable)
- Directory structure: flat files in `plugins/analysis/`, no subdirs needed

### 2. Config syntax: How to enable in config.yaml?

**Answer:** Explicit plugin names in config.yaml `plugins.analysis` array (existing pattern).

**Example:**
```yaml
plugins:
  analysis:
    - JSASTAnalyzer
    - Sqlite3Analyzer      # Package-specific
    - PrismaAnalyzer        # Another package
    - DatabaseAnalyzer      # Fallback (deprecated)
```

**No changes to config schema needed.**

### 3. Auto-detection: Should plugins auto-activate based on package.json?

**Answer:** NO in v0.2. Explicit config only. Auto-detection deferred to v0.3 as opt-in feature.

**Rationale:**
- Principle of least surprise (users control what runs)
- No false positives from unused dependencies
- Consistent with existing plugin loading (Express, NestJS, etc.)
- Future enhancement path is clear (add `autoDetect: true` flag)

### 4. Deprecation: Remove DatabaseAnalyzer or keep as fallback?

**Answer:** Keep as deprecated fallback through v0.4, remove in v0.5.

**Migration timeline:**
- v0.2: Mark deprecated, add warning, update DEFAULT_CONFIG to use Sqlite3Analyzer
- v0.3: Remove from DEFAULT_CONFIG (users must explicitly list if wanted)
- v0.5: Remove entirely (breaking change, documented)

## Blocked Tasks

**REG-260: Create npm/sqlite3 analyzer plugin**
- Blocked by this task
- Once architecture is approved, REG-260 will:
  1. Rename SQLiteAnalyzer → Sqlite3Analyzer
  2. Add package metadata field
  3. Update tests and docs
  4. This is mostly a refactoring of existing code

## Next Steps

1. Get architectural approval from user (Вадим)
2. If approved → proceed to REG-260 (implement Sqlite3Analyzer)
3. REG-260 will serve as reference implementation for future package analyzers (Prisma, Postgres, etc.)

## Open Questions

None. All design questions answered above.

---

**Recommendation:** Approve architecture. It's minimal, leverages existing patterns (ExpressAnalyzer, SQLiteAnalyzer), requires no new abstractions, and provides clear extension path for future package-specific analyzers.
