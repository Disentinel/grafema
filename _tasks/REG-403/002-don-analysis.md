# REG-403: Don Melton - Codebase Analysis

## 1. Current Config Architecture Summary

### Config Type Definition

**File:** `/Users/vadimr/grafema-worker-2/packages/core/src/config/ConfigLoader.ts`

The `GrafemaConfig` interface defines the full config shape:

```typescript
export interface GrafemaConfig {
  plugins: {
    discovery?: string[];
    indexing: string[];
    analysis: string[];
    enrichment: string[];
    validation: string[];
  };
  services: ServiceDefinition[];
  include?: string[];
  exclude?: string[];
  strict?: boolean;
  workspace?: WorkspaceConfig;
}
```

Currently **no `version` field** exists anywhere in the config type or schema.

### Config Loading Flow

`loadConfig(projectPath, logger)` in `ConfigLoader.ts` (lines 166-243):

1. Looks for `.grafema/config.yaml` (preferred)
2. Falls back to `.grafema/config.json` (deprecated, with warning)
3. Returns `DEFAULT_CONFIG` if neither exists
4. YAML is parsed with the `yaml` package, then manually validated field-by-field
5. Validation uses **hand-rolled validators** (no Ajv/Zod for the config itself -- Ajv exists in dependencies but is used elsewhere)
6. After validation, merges user partial config with `DEFAULT_CONFIG` via `mergeConfig()`

### Config Consumers

Config is loaded in three places:

| Consumer | File | How |
|----------|------|-----|
| CLI `analyze` command | `packages/cli/src/commands/analyze.ts:300` | `loadConfig(projectPath, logger)` directly from `@grafema/core` |
| CLI `doctor` command | `packages/cli/src/commands/doctor/checks.ts:18` | `loadConfig` from `@grafema/core` (for config validity check) |
| MCP server | `packages/mcp/src/config.ts:116-127` | Wraps core `loadConfig()`, adds MCP-specific defaults |

### Config Writers

Config is written in two places:

| Writer | File | What |
|--------|------|------|
| CLI `init` command | `packages/cli/src/commands/init.ts:20-48` | `generateConfigYAML()` writes default config |
| MCP `write_config` tool | `packages/mcp/src/handlers.ts:1282-1370+` | Writes config from AI agent input |

### Existing Validation Pattern

All validators follow the same pattern:
- Receive `unknown` typed input
- Throw `Error` with `"Config error: ..."` prefix on invalid input
- Accept `undefined`/`null` as valid (means "use defaults")
- Validate is called OUTSIDE try-catch so config errors propagate as crashes (fail loudly)

### Version Availability at Runtime

Current Grafema version `0.2.5-beta` is available from multiple `package.json` files:

| Package | Version | package.json |
|---------|---------|--------------|
| Root monorepo | `0.2.5-beta` | `package.json` |
| `@grafema/core` | `0.2.5-beta` | `packages/core/package.json` |
| `@grafema/cli` | `0.2.5-beta` | `packages/cli/package.json` |
| `@grafema/mcp` | `0.2.5-beta` | `packages/mcp/package.json` |

**How each consumer gets version today:**
- CLI (`cli.ts:30`): reads `package.json` via `readFileSync` at startup for `--version` flag
- Doctor (`checks.ts:568-615`): reads CLI and core `package.json` for informational display
- MCP server (`server.ts:87`): hardcoded `version: '0.1.0'` (stale -- separate concern)

No centralized `getVersion()` utility exists.

## 2. Where to Add the `version` Field

### In the Config Type

Add `version` as an **optional** field on `GrafemaConfig`:

```typescript
export interface GrafemaConfig {
  /** Config schema version. Must match the major version of Grafema that reads it. */
  version?: string;
  plugins: { ... };
  services: ServiceDefinition[];
  // ... rest unchanged
}
```

Optional because:
- Existing configs without `version` must continue to work (backward compat requirement from user request)
- `DEFAULT_CONFIG` can set it to the current version

### In the Default Config

```typescript
export const DEFAULT_CONFIG: GrafemaConfig = {
  version: '0.2',  // or computed from package.json
  plugins: { ... },
  // ...
};
```

### In Config Writers

Both `generateConfigYAML()` (init) and `handleWriteConfig()` (MCP) must include `version` when writing new configs.

## 3. Where to Add Validation

### In `loadConfig()` -- After Parsing, Before Merge

Add a `validateVersion()` call alongside existing `validateServices()`, `validatePatterns()`, `validateWorkspace()`.

The validation should happen:
1. **After** YAML/JSON is parsed successfully
2. **Before** `mergeConfig()` is called
3. **Outside** the try-catch (like all other validators -- fail loudly)

```
// Validate version compatibility (THROWS on error)
validateVersion(parsed.version);
```

### Validation Logic

```typescript
export function validateVersion(
  configVersion: unknown,
  currentVersion?: string  // injectable for testing
): void {
  // No version field = backward compat, accept silently
  if (configVersion === undefined || configVersion === null) {
    return;
  }

  // Must be a string
  if (typeof configVersion !== 'string') {
    throw new Error(`Config error: version must be a string, got ${typeof configVersion}`);
  }

  // Must be non-empty
  if (!configVersion.trim()) {
    throw new Error('Config error: version cannot be empty');
  }

  // Compare major.minor with current Grafema version
  const current = currentVersion ?? getGrafemaVersion();
  if (!isCompatibleVersion(configVersion, current)) {
    throw new Error(
      `Config error: config version "${configVersion}" is not compatible with ` +
      `Grafema ${current}. Please update your config or Grafema.\n` +
      `  Run: grafema init --force  (to regenerate config for current version)`
    );
  }
}
```

## 4. Version Compatibility Strategy

### Recommendation: Major.Minor Comparison (not semver, not exact)

**Why not exact match?**
- Patch versions (`0.2.4` -> `0.2.5`) should never break config schema
- Exact match would force users to update config on every patch release -- terrible UX

**Why not just major?**
- Grafema is pre-1.0 (`0.2.x`). In semver pre-1.0, the minor version can contain breaking changes
- Major version is `0` for all current releases, so major-only check is useless

**Why not full semver library?**
- No `semver` dependency exists in the project
- The comparison logic is simple enough to implement inline (< 20 lines)
- Avoids adding a dependency for 3 lines of logic

### Proposed Approach: Config Version is `major.minor` Only

The config `version` field stores only `major.minor` (e.g., `"0.2"`, not `"0.2.5-beta"`).

**Rationale:**
1. Configs don't change on patch releases
2. Simpler for users to understand
3. No need to strip pre-release tags
4. When comparing: parse `major.minor` from both config and runtime, compare equality

```typescript
function getConfigSchemaVersion(version: string): string {
  // "0.2.5-beta" -> "0.2"
  // "0.2" -> "0.2"
  // "1.0.0" -> "1.0"
  const parts = version.split('.');
  return `${parts[0]}.${parts[1]}`;
}

function isCompatibleVersion(configVersion: string, grafemaVersion: string): boolean {
  const configSchema = getConfigSchemaVersion(configVersion);
  const currentSchema = getConfigSchemaVersion(grafemaVersion);
  return configSchema === currentSchema;
}
```

So if Grafema is `0.2.5-beta` and config says `version: "0.2"`, it passes.
If Grafema is upgraded to `0.3.0` and config still says `version: "0.2"`, it fails with a clear message.

### Getting the Runtime Version

Need a utility function in `@grafema/core` that reads its own `package.json` version. Two approaches:

**Option A: Read package.json at module load time**
```typescript
// In packages/core/src/version.ts
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
export const GRAFEMA_VERSION: string = pkg.version;
```

**Option B: Hardcoded constant updated by release script**

Option A is better because:
- Already the pattern used in CLI (`cli.ts:30`) and doctor (`checks.ts:577`)
- No risk of forgetting to update
- Works with the existing release process that bumps `package.json` versions

## 5. Specific Files That Need Changes

### Core Changes (must happen)

| File | Change | Impact |
|------|--------|--------|
| `packages/core/src/config/ConfigLoader.ts` | Add `version?` to `GrafemaConfig`, add `validateVersion()`, add to `mergeConfig()`, update `DEFAULT_CONFIG` | Config type, loading, validation |
| `packages/core/src/config/index.ts` | Export `validateVersion` | Public API |
| `packages/core/src/version.ts` | **NEW FILE** - export `GRAFEMA_VERSION` constant | Version source of truth for core |
| `packages/core/src/index.ts` | Export `GRAFEMA_VERSION` from `version.ts` | Public API |

### Config Writer Changes

| File | Change | Impact |
|------|--------|--------|
| `packages/cli/src/commands/init.ts` | Add `version` to `generateConfigYAML()` output | New configs include version |
| `packages/mcp/src/handlers.ts` | Add `version` to `handleWriteConfig()` output | MCP-written configs include version |
| `packages/mcp/src/definitions.ts` | Add `version` to `write_config` tool schema | Tool API |
| `packages/mcp/src/types.ts` | Add `version?` to `WriteConfigArgs` | Type |

### Test Changes

| File | Change | Impact |
|------|--------|--------|
| `test/unit/config/ConfigLoader.test.ts` | Add tests for version validation | Unit tests |

### Fixture Updates (optional but recommended)

| File | Change |
|------|--------|
| `test/fixtures/09-cross-service/.grafema/config.yaml` | Add `version: "0.2"` (optional -- backward compat means it works without) |

## 6. Risks and Considerations

### Risk 1: Backward Compatibility (LOW)
**Concern:** Existing configs without `version` field.
**Mitigation:** `version` is optional. `validateVersion()` accepts `undefined`/`null` silently. No breaking change.

### Risk 2: Version Drift Between Packages (LOW)
**Concern:** Different packages might have different versions.
**Mitigation:** All packages use unified versioning (`0.2.5-beta` everywhere). The `release.sh` script bumps all together. Reading from `@grafema/core/package.json` is the right source.

### Risk 3: Config Written by Older/Newer Grafema (MEDIUM)
**Concern:** User runs `grafema init` with v0.2, then upgrades to v0.3. Config has `version: "0.2"`.
**Mitigation:** Error message clearly tells user to run `grafema init --force` to regenerate. This is the exact use case this feature solves.

### Risk 4: Pre-release Versions (LOW)
**Concern:** Version `0.2.5-beta` vs `0.2.5` -- should they be compatible?
**Mitigation:** Config version is `major.minor` only (`"0.2"`), so pre-release tags are irrelevant.

### Risk 5: Tests With Config Fixtures (LOW)
**Concern:** Adding version to DEFAULT_CONFIG might affect test assertions comparing against it.
**Mitigation:** Review `test/unit/config/ConfigLoader.test.ts` -- tests use `DEFAULT_CONFIG` reference directly (e.g., `assert.deepStrictEqual(config, DEFAULT_CONFIG)`), so they'll still pass if DEFAULT_CONFIG is updated consistently.

### Risk 6: MCP Hardcoded Version (SEPARATE CONCERN)
**Observation:** MCP server has `version: '0.1.0'` hardcoded in `server.ts:87`. This is a separate issue -- not blocking for REG-403, but worth noting. The MCP server version should eventually use `GRAFEMA_VERSION` too.

## 7. Recommended Implementation Order

1. Create `packages/core/src/version.ts` with `GRAFEMA_VERSION` export
2. Add `version?` field to `GrafemaConfig` interface
3. Add `version` to `DEFAULT_CONFIG`
4. Implement `validateVersion()` function
5. Wire validation into `loadConfig()` (both YAML and JSON paths)
6. Update `mergeConfig()` to handle version field
7. Export new symbols from `packages/core/src/config/index.ts` and `packages/core/src/index.ts`
8. Update `generateConfigYAML()` in init command
9. Update `handleWriteConfig()` in MCP handlers
10. Update `WriteConfigArgs` type and `write_config` tool definition
11. Write comprehensive tests
12. Verify all existing tests still pass

## 8. Config Schema Version Value

The config `version` field should be `"0.2"` -- matching the current major.minor.

Example of what a config.yaml will look like after this change:

```yaml
# Grafema Configuration
version: "0.2"

plugins:
  indexing:
    - JSModuleIndexer
  analysis:
    - JSASTAnalyzer
  enrichment:
    - MethodCallResolver
  validation:
    - EvalBanValidator
```

## 9. Summary

This is a clean, well-scoped feature. The existing validation architecture (`validateServices`, `validatePatterns`, `validateWorkspace`) provides a clear pattern to follow. The main decision point is version comparison strategy, where major.minor equality is the pragmatic choice for a pre-1.0 project.

No architectural issues. No existing patterns to refactor. Straightforward implementation touching ~6 production files and ~1 test file.
