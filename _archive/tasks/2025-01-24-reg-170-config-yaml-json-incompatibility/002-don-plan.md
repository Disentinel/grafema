# Don Melton: REG-170 Analysis and Plan

## Executive Summary

This is a **critical blocker** for 0.1.1-alpha and a clear architectural mismatch. Users configure their project with YAML (`grafema init` creates `config.yaml`), then the config is completely ignored because `grafema analyze` reads a different file (`config.json`). This isn't a minor bug - it's a fundamental UX failure.

**Root cause**: CLI and MCP modules evolved independently with different config formats. No shared config loading utility.

**The right solution**: Unify on YAML (more user-friendly, already in use by `init`), create shared config loader, support migration path for existing users.

## Codebase Analysis

### Current State

**1. Init command (`packages/cli/src/commands/init.ts`)**
- Line 38: `const configPath = join(grafemaDir, 'config.yaml');`
- Creates YAML config with structure:
  ```yaml
  include:
    - "src/**/*.{ts,js,tsx,jsx}"
  exclude:
    - "**/*.test.ts"
    - "node_modules/**"
  analysis:
    maxFileSize: 1MB
    timeout: 30s
  ```
- Detects project structure (monorepo, src/lib) and customizes patterns
- NO actual file filtering implementation - just writes YAML

**2. Analyze command (`packages/cli/src/commands/analyze.ts`)**
- Line 123: `const configPath = join(projectPath, '.grafema', 'config.json');`
- Function `loadConfig()` (lines 122-133):
  - Returns `{ plugins: DEFAULT_PLUGINS }` if config.json doesn't exist
  - Never looks for config.yaml
  - Only reads `plugins` config section (indexing/analysis/enrichment/validation)
- **NO support for `include`/`exclude` patterns** - not even in the config schema

**3. MCP server (`packages/mcp/src/config.ts`)**
- Line 141: `const configPath = join(projectPath, '.grafema', 'config.json');`
- Same `loadConfig()` function as CLI
- Creates default config.json if missing
- Also only reads `plugins` section

**4. Config.yaml structure NOT USED**
- `include`/`exclude` patterns - **NOT IMPLEMENTED ANYWHERE**
- `analysis.maxFileSize` - **NOT IMPLEMENTED**
- `analysis.timeout` - **NOT IMPLEMENTED**

**5. Dependencies**
- `@grafema/core` has `yaml: ^2.8.2` dependency (package.json line 50)
- CLI package does NOT have yaml dependency
- This is already available, just not used

### What Actually Controls File Selection

Looking at `JSModuleIndexer.ts` (line 29-38):
- Uses hardcoded `DEFAULT_TEST_PATTERNS` for test file exclusion
- No config-based file filtering
- File discovery happens via DFS from entrypoint (package.json main field)
- NO glob-based include/exclude mechanism exists

`SimpleProjectDiscovery.ts` (line 73):
- Reads `package.json` main field as entrypoint
- No pattern-based file discovery

**Architecture gap**: File selection is entrypoint-based (follow imports from main), not pattern-based (glob include/exclude). The config.yaml promises features that don't exist.

## Root Cause

### Primary Issue
**Format inconsistency**: `init` writes YAML, `analyze` reads JSON.

This happened because:
1. Init command was written to create user-friendly config
2. Analyze command and MCP were written independently
3. No shared config loading utility
4. No integration test covering init → analyze workflow (REG-158 just added this)

### Secondary Issue (More Critical)
**Feature mismatch**: The config.yaml includes `include`/`exclude` patterns that **NOTHING reads or respects**.

This is worse than the format mismatch - we're making promises to users that the system can't keep.

**Current file discovery**:
- Follows imports from entrypoint (package.json main field)
- Hardcoded test file exclusion patterns
- No glob-based filtering exists in codebase

**User expectation from config.yaml**:
- Glob patterns control what files are analyzed
- Can exclude specific directories

These are incompatible models.

## Architectural Mismatch

The config.yaml was written with a **glob-based discovery model** in mind:
```yaml
include:
  - "src/**/*.{ts,js,tsx,jsx}"
exclude:
  - "node_modules/**"
```

But Grafema actually uses an **entrypoint-based discovery model**:
1. Find entrypoint from package.json
2. DFS through imports
3. Build dependency tree

**Question for user**: Which model should Grafema use?

### Option A: Entrypoint-based (current)
- Pro: Finds only code that's actually used
- Pro: Follows real module graph
- Con: Config `include`/`exclude` don't make sense
- Con: Can't analyze dead code or standalone scripts

### Option B: Glob-based
- Pro: Can analyze any file matching patterns
- Pro: More control for users
- Con: Will index unused files
- Con: Major architectural change to Orchestrator/discovery

### Option C: Hybrid
- Pro: Best of both worlds
- Pro: `include` as initial file set, follow imports from there
- Con: More complex
- Con: Need clear semantics for interaction

**My recommendation**: Option A (entrypoint-based) with explicit config structure. The current model is right for Grafema's vision (graph-driven analysis). But we need to fix the config to match reality.

## High-Level Plan

### Step 1: Config Format Unification (Breaking the Symptom)

**1.1 Create shared config loader**
- New file: `packages/core/src/config/ConfigLoader.ts`
- Reads `config.yaml` first (preferred)
- Falls back to `config.json` (migration path)
- Uses `yaml` package (already in core dependencies)
- Returns typed config object

**1.2 Define actual config schema**
```typescript
interface GrafemaConfig {
  plugins: {
    indexing: string[];
    analysis: string[];
    enrichment: string[];
    validation: string[];
  };
  // Future: file patterns (when implemented)
  // include?: string[];
  // exclude?: string[];
}
```

**1.3 Update init command**
- Write config.yaml with ONLY implemented features
- Remove `include`/`exclude`/`analysis` sections until implemented
- Keep it minimal and honest

**1.4 Update analyze command**
- Import shared ConfigLoader
- Load from config.yaml (json as fallback)
- Remove duplicate loadConfig() function

**1.5 Update MCP**
- Import shared ConfigLoader
- Same migration path

### Step 2: Migration Path

**2.1 ConfigLoader behavior**
```typescript
function loadConfig(projectPath: string): GrafemaConfig {
  const yamlPath = join(projectPath, '.grafema', 'config.yaml');
  const jsonPath = join(projectPath, '.grafema', 'config.json');

  // Prefer YAML
  if (existsSync(yamlPath)) {
    return parseYAML(yamlPath);
  }

  // Fallback to JSON (migration)
  if (existsSync(jsonPath)) {
    warnDeprecation('config.json deprecated, use config.yaml');
    return parseJSON(jsonPath);
  }

  // No config - return defaults
  return DEFAULT_CONFIG;
}
```

**2.2 Warning message**
```
⚠ config.json is deprecated. Run `grafema init --force` to migrate to config.yaml
```

**2.3 Migration command** (future enhancement)
```bash
grafema migrate-config
```
Converts existing config.json → config.yaml

### Step 3: Testing

**3.1 Unit tests for ConfigLoader**
- Reads YAML correctly
- Reads JSON correctly
- Prefers YAML when both exist
- Returns defaults when neither exists
- Validates config schema

**3.2 E2E test (already exists in REG-158)**
- Verify init → analyze workflow works
- Config.yaml is created and respected

**3.3 Migration test**
- Create config.json
- Run analyze
- Verify deprecation warning
- Verify config still works

### Step 4: Documentation

**4.1 Update init output**
```
✓ Created .grafema/config.yaml
  → Customize plugin list in .grafema/config.yaml
  → Run "grafema analyze" to build the code graph
```

**4.2 Config file comment**
```yaml
# Grafema Configuration
# Docs: https://github.com/grafema/grafema#configuration

# Plugins to run during analysis
# See available plugins: https://github.com/grafema/grafema#plugins
plugins:
  indexing:
    - JSModuleIndexer
  # ...
```

**4.3 Deprecation notice in CHANGELOG**
```
### Breaking Changes
- Config format changed from JSON to YAML
- Old config.json still works but is deprecated
- Run `grafema init --force` to migrate
```

## What NOT to Include (Critical)

**Do NOT add `include`/`exclude` support in this task.**

Why:
1. It doesn't exist architecturally
2. Requires fundamental changes to file discovery
3. Needs separate design discussion
4. Scope creep will delay the blocker fix

**This task**: Fix the config format mismatch
**Future task** (REG-TBD): Design and implement glob-based file filtering

## Risks and Considerations

### 1. Breaking Change Impact
**Risk**: Users with custom config.json will see deprecation warnings

**Mitigation**:
- Support both formats during migration period
- Clear warning with migration instructions
- Automated migration command (future)

### 2. YAML Parser Dependency
**Status**: Already in `@grafema/core` dependencies
**Action**: Add to `@grafema/cli` dependencies (for init command to write YAML)

### 3. Config Schema Validation
**Risk**: Invalid YAML crashes analyze

**Mitigation**:
- Parse errors should show clear message
- Validate config schema after parsing
- Provide example in error message

### 4. Feature Expectations
**Risk**: Users expect `include`/`exclude` to work (from init template)

**Mitigation**:
- Remove unimplemented features from init template
- Add comment in config: "# File discovery: follows imports from package.json main"
- Document current behavior clearly

### 5. Test File Exclusion
**Current**: Hardcoded patterns in JSModuleIndexer
**Future**: Move to config when pattern support is implemented
**This task**: Document current behavior

## Migration Strategy

### Phase 1: Shared Loader (This Task)
- Create ConfigLoader in core
- Update CLI to use it
- Update MCP to use it
- Support both YAML and JSON (YAML preferred)

### Phase 2: Deprecation (Next Release)
- Add warnings for config.json usage
- Update all docs to use YAML
- Provide migration command

### Phase 3: Removal (Future Release)
- Drop JSON support entirely
- Clean up migration code

### Phase 4: Feature Implementation (Separate Epic)
- Design glob-based file filtering
- Implement include/exclude patterns
- Add to config schema
- Update init template

## Acceptance Criteria Revisited

From the issue:
1. ✅ **Unify config format (YAML preferred)** - Shared ConfigLoader, YAML first
2. ✅ **`analyze` reads `config.yaml`** - Via ConfigLoader
3. ⚠️ **Support `include`/`exclude` patterns from config** - OUT OF SCOPE (requires architecture work)
4. ✅ **Migration path for existing `config.json` users** - Fallback + deprecation warning

**Revised AC #3**: Document that file discovery is entrypoint-based. Create separate issue for glob pattern support.

## Recommendation

### Immediate Action
1. Fix the format mismatch (YAML everywhere)
2. Remove misleading config sections from init template
3. Document actual behavior clearly
4. Support migration path

### Separate Issue Required
Create Linear issue: "REG-TBD: Implement glob-based file filtering with include/exclude patterns"
- Team: Reginaflow
- Priority: Medium (not blocker)
- Requires: Architecture discussion
- Scope: File discovery redesign

### Why This is RIGHT
- Fixes the blocker (users can configure plugins)
- Doesn't promise features we don't have
- Clean migration path
- Preserves current working behavior
- Separates format fix from feature addition

## Files to Change

1. **New**: `packages/core/src/config/ConfigLoader.ts`
2. **New**: `packages/core/src/config/index.ts` (exports)
3. **Modify**: `packages/cli/src/commands/init.ts` (simplified template)
4. **Modify**: `packages/cli/src/commands/analyze.ts` (use ConfigLoader)
5. **Modify**: `packages/mcp/src/config.ts` (use ConfigLoader)
6. **Modify**: `packages/cli/package.json` (add yaml dependency)
7. **New**: `test/unit/config/ConfigLoader.test.ts`
8. **Modify**: `packages/cli/test/cli.test.ts` (E2E verification)

## Open Questions for User

1. **File discovery model**: Should we keep entrypoint-based, or move to glob-based? (Recommend: keep current, document it)

2. **Config sections**: Should init create a minimal config with only plugins, or include commented-out future features?

3. **Migration timeline**: When should we drop config.json support entirely? (Recommend: 0.2.0 or later)

4. **Deprecation verbosity**: Should the warning appear every time, or only once per project? (Recommend: every time, but make it subtle)

## Success Criteria

After this task:
- ✅ `grafema init` creates `config.yaml` with only implemented features
- ✅ `grafema analyze` reads `config.yaml` (falls back to config.json)
- ✅ MCP reads `config.yaml` (falls back to config.json)
- ✅ E2E test passes (init → analyze → query)
- ✅ Clear deprecation path documented
- ✅ Users can customize plugin list successfully
- ✅ No false promises about unimplemented features

This is the RIGHT solution: fix what's broken, be honest about what's not implemented, create clear path forward.
