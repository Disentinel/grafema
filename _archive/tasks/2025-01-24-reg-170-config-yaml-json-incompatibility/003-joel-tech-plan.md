# Joel Spolsky: REG-170 Technical Specification

## Executive Summary

This spec implements **format unification** for Grafema config files, switching from JSON to YAML. The scope is tightly focused on format migration only — `include`/`exclude` pattern support is deferred to a separate issue per user decision.

**Key changes:**
1. Create shared `ConfigLoader` in `@grafema/core`
2. Update `init` command to write minimal, honest config (plugins only)
3. Update `analyze` and MCP to use shared loader
4. Support migration path (YAML preferred, JSON fallback with warning)
5. Add yaml dependency to `@grafema/cli`

**Implementation order:** ConfigLoader → tests → init → analyze → MCP

---

## 1. New Files

### 1.1 ConfigLoader Module

**File:** `packages/core/src/config/ConfigLoader.ts`

**Purpose:** Shared config loading logic for CLI and MCP with YAML-first, JSON-fallback strategy.

**Interface:**

```typescript
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parse as parseYAML } from 'yaml';

/**
 * Grafema configuration schema.
 * Only includes actually implemented features (plugins list).
 * Future: include/exclude patterns when glob-based filtering is implemented.
 */
export interface GrafemaConfig {
  plugins: {
    indexing: string[];
    analysis: string[];
    enrichment: string[];
    validation: string[];
  };
}

/**
 * Default plugin configuration.
 * Matches current DEFAULT_PLUGINS in analyze.ts and config.ts (MCP).
 */
export const DEFAULT_CONFIG: GrafemaConfig = {
  plugins: {
    indexing: ['JSModuleIndexer'],
    analysis: [
      'JSASTAnalyzer',
      'ExpressRouteAnalyzer',
      'SocketIOAnalyzer',
      'DatabaseAnalyzer',
      'FetchAnalyzer',
      'ServiceLayerAnalyzer',
    ],
    enrichment: [
      'MethodCallResolver',
      'AliasTracker',
      'ValueDomainAnalyzer',
      'MountPointResolver',
      'PrefixEvaluator',
      'ImportExportLinker',
      'HTTPConnectionEnricher',
    ],
    validation: [
      'CallResolverValidator',
      'EvalBanValidator',
      'SQLInjectionValidator',
      'ShadowingDetector',
      'GraphConnectivityValidator',
      'DataFlowValidator',
      'TypeScriptDeadCodeValidator',
    ],
  },
};

/**
 * Load Grafema config from project directory.
 *
 * Priority:
 * 1. config.yaml (preferred)
 * 2. config.json (deprecated, fallback)
 * 3. DEFAULT_CONFIG (if neither exists)
 *
 * Warnings:
 * - Logs deprecation warning if config.json is used
 * - Logs parse errors but doesn't throw (returns defaults)
 *
 * @param projectPath - Absolute path to project root
 * @param logger - Optional logger for warnings (defaults to console.warn)
 * @returns Parsed config or defaults
 */
export function loadConfig(
  projectPath: string,
  logger: { warn: (msg: string) => void } = console
): GrafemaConfig {
  const grafemaDir = join(projectPath, '.grafema');
  const yamlPath = join(grafemaDir, 'config.yaml');
  const jsonPath = join(grafemaDir, 'config.json');

  // 1. Try YAML first (preferred)
  if (existsSync(yamlPath)) {
    try {
      const content = readFileSync(yamlPath, 'utf-8');
      const parsed = parseYAML(content) as Partial<GrafemaConfig>;

      // Merge with defaults (user config may be partial)
      return mergeConfig(DEFAULT_CONFIG, parsed);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.warn(`Failed to parse config.yaml: ${error.message}`);
      logger.warn('Using default configuration');
      return DEFAULT_CONFIG;
    }
  }

  // 2. Fallback to JSON (migration path)
  if (existsSync(jsonPath)) {
    logger.warn('⚠ config.json is deprecated. Run "grafema init --force" to migrate to config.yaml');

    try {
      const content = readFileSync(jsonPath, 'utf-8');
      const parsed = JSON.parse(content) as Partial<GrafemaConfig>;
      return mergeConfig(DEFAULT_CONFIG, parsed);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.warn(`Failed to parse config.json: ${error.message}`);
      logger.warn('Using default configuration');
      return DEFAULT_CONFIG;
    }
  }

  // 3. No config file - return defaults
  return DEFAULT_CONFIG;
}

/**
 * Merge user config with defaults.
 * User config takes precedence, but missing sections use defaults.
 */
function mergeConfig(
  defaults: GrafemaConfig,
  user: Partial<GrafemaConfig>
): GrafemaConfig {
  return {
    plugins: {
      indexing: user.plugins?.indexing ?? defaults.plugins.indexing,
      analysis: user.plugins?.analysis ?? defaults.plugins.analysis,
      enrichment: user.plugins?.enrichment ?? defaults.plugins.enrichment,
      validation: user.plugins?.validation ?? defaults.plugins.validation,
    },
  };
}
```

**Why this design:**
- **YAML-first:** More user-friendly, already used by `init` (lines match Don's analysis)
- **Graceful fallback:** Supports migration without breaking existing users
- **Parse error handling:** Logs but doesn't crash — returns defaults instead
- **Minimal interface:** Only `loadConfig()` exported, implementation details hidden
- **Logger injection:** Allows MCP/CLI to control warning output (MCP uses `log()` util)

---

### 1.2 Config Module Index

**File:** `packages/core/src/config/index.ts`

```typescript
/**
 * Configuration loading utilities
 */
export { loadConfig, DEFAULT_CONFIG } from './ConfigLoader.js';
export type { GrafemaConfig } from './ConfigLoader.js';
```

**Why:** Clean public API, follows existing core package structure (see `src/diagnostics/index.ts`, `src/errors/GrafemaError.ts`)

---

## 2. File Modifications

### 2.1 Core Index Exports

**File:** `packages/core/src/index.ts`

**Change:** Add config exports after diagnostics section (around line 24)

```typescript
// Diagnostics
export { DiagnosticCollector, DiagnosticReporter, DiagnosticWriter } from './diagnostics/index.js';
export type { Diagnostic, DiagnosticInput, ReportOptions, SummaryStats } from './diagnostics/index.js';

// Config
export { loadConfig, DEFAULT_CONFIG } from './config/index.js';
export type { GrafemaConfig } from './config/index.js';

// Main orchestrator
export { Orchestrator } from './Orchestrator.js';
```

**Why:** Make ConfigLoader available to `@grafema/cli` and `@grafema/mcp` packages.

---

### 2.2 Init Command

**File:** `packages/cli/src/commands/init.ts`

**Changes:**

1. **Import yaml library** (top of file, after existing imports):

```typescript
import { stringify as stringifyYAML } from 'yaml';
import { DEFAULT_CONFIG } from '@grafema/core';
```

2. **Replace DEFAULT_CONFIG constant** (lines 10-25) with:

```typescript
/**
 * Generate config.yaml content with commented future features.
 * Only includes implemented features (plugins).
 */
function generateConfigYAML(): string {
  // Start with working default config
  const config = {
    // Plugin list (fully implemented)
    plugins: DEFAULT_CONFIG.plugins,
  };

  // Convert to YAML
  const yaml = stringifyYAML(config, {
    lineWidth: 0, // Don't wrap long lines
  });

  // Add header comment
  return `# Grafema Configuration
# Documentation: https://github.com/grafema/grafema#configuration

${yaml}
# Future: File discovery patterns (not yet implemented)
# Grafema currently uses entrypoint-based discovery (follows imports from package.json main field)
# Glob-based include/exclude patterns will be added in a future release
#
# include:
#   - "src/**/*.{ts,js,tsx,jsx}"
# exclude:
#   - "**/*.test.ts"
#   - "node_modules/**"
`;
}
```

3. **Update config writing** (line 94):

```typescript
// Write config
const configContent = generateConfigYAML();
writeFileSync(configPath, configContent);
console.log('✓ Created .grafema/config.yaml');
```

**Why these changes:**
- **Honest config:** Only shows what actually works (plugins), not promises we can't keep
- **Future-proof:** Comments show where we're going (include/exclude) without misleading users
- **Uses DEFAULT_CONFIG:** Single source of truth for default plugins
- **Clear docs:** Header explains what the file does, where to learn more
- **User education:** Comment explains current entrypoint-based model

**Removed sections:**
- `include:` patterns (not implemented)
- `exclude:` patterns (not implemented)
- `analysis.maxFileSize` (not implemented)
- `analysis.timeout` (not implemented)

**Detection logic** (lines 74-91 - monorepo/src/lib detection):
- **KEEP AS-IS** for now (even though it generates unused patterns in comments)
- This logic will be useful when we implement glob-based filtering
- For now, it just shows intent in comments

---

### 2.3 Analyze Command

**File:** `packages/cli/src/commands/analyze.ts`

**Changes:**

1. **Import shared config loader** (add to imports, line 8):

```typescript
import { loadConfig, type GrafemaConfig } from '@grafema/core';
```

2. **Remove local interfaces and config** (DELETE lines 48-133):
   - `interface PluginConfig` → now in `@grafema/core`
   - `interface ProjectConfig` → now `GrafemaConfig` from core
   - `const DEFAULT_PLUGINS` → now `DEFAULT_CONFIG.plugins` from core
   - `function loadConfig()` → now imported from core

3. **Update loadConfig call** (line 204):

**BEFORE:**
```typescript
const config = loadConfig(projectPath);
const plugins = createPlugins(config.plugins || DEFAULT_PLUGINS);
```

**AFTER:**
```typescript
const config = loadConfig(projectPath, logger);
const plugins = createPlugins(config.plugins);
```

**Note:** Pass `logger` to loadConfig so deprecation warnings respect CLI log level.

4. **Update createPlugins signature** (line 135):

**BEFORE:**
```typescript
function createPlugins(config: PluginConfig): Plugin[] {
```

**AFTER:**
```typescript
function createPlugins(config: GrafemaConfig['plugins']): Plugin[] {
```

**Why these changes:**
- **DRY:** Remove 80+ lines of duplicate code
- **Single source:** Config logic lives in one place (core)
- **Logger integration:** Warnings respect `--quiet`, `--log-level` flags
- **Type safety:** GrafemaConfig ensures compatibility

---

### 2.4 MCP Config

**File:** `packages/mcp/src/config.ts`

**Changes:**

1. **Import shared loader** (add to imports, line 8):

```typescript
import { loadConfig as loadConfigFromCore, type GrafemaConfig } from '@grafema/core';
```

2. **Remove duplicate types/constants** (DELETE lines 44-99):
   - `export interface PluginConfig` → use `GrafemaConfig['plugins']` from core
   - `export interface ProjectConfig` → use `GrafemaConfig` from core, add MCP-specific fields
   - `export const DEFAULT_CONFIG` → use from core

3. **Define MCP-specific config type** (add after imports):

```typescript
/**
 * MCP-specific configuration extends GrafemaConfig with additional fields.
 */
export interface MCPConfig extends GrafemaConfig {
  discovery?: {
    enabled: boolean;
    customOnly: boolean;
  };
  analysis?: {
    service?: string;
  };
  backend?: 'local' | 'rfdb';
  rfdb_socket?: string;
}

const MCP_DEFAULTS: Pick<MCPConfig, 'discovery'> = {
  discovery: {
    enabled: true,
    customOnly: false,
  },
};
```

4. **Update loadConfig function** (replace lines 140-167):

**BEFORE:**
```typescript
export function loadConfig(projectPath: string): ProjectConfig {
  const configPath = join(projectPath, '.grafema', 'config.json');

  if (!existsSync(configPath)) {
    // Creates default config.json...
  }

  try {
    const configContent = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(configContent) as Partial<ProjectConfig>;
    log(`[Grafema MCP] Loaded config from ${configPath}`);
    return { ...DEFAULT_CONFIG, ...config };
  } catch (err) {
    log(`[Grafema MCP] Failed to load config: ${(err as Error).message}, using defaults`);
    return DEFAULT_CONFIG;
  }
}
```

**AFTER:**
```typescript
/**
 * Load MCP configuration (extends base GrafemaConfig).
 * Uses shared ConfigLoader but adds MCP-specific defaults.
 */
export function loadConfig(projectPath: string): MCPConfig {
  // Use shared loader (handles YAML/JSON, deprecation warnings)
  const baseConfig = loadConfigFromCore(projectPath, {
    warn: (msg) => log(`[Grafema MCP] ${msg}`),
  });

  // Add MCP-specific defaults
  return {
    ...baseConfig,
    ...MCP_DEFAULTS,
  };
}
```

5. **Update createPlugins signature** (line 214):

**BEFORE:**
```typescript
export function createPlugins(
  pluginNames: string[],
  customPluginMap: Record<string, new () => unknown> = {}
): unknown[] {
```

**AFTER:**
```typescript
export function createPlugins(
  config: GrafemaConfig['plugins'],
  customPluginMap: Record<string, new () => unknown> = {}
): unknown[] {
  const pluginNames = [
    ...config.indexing,
    ...config.analysis,
    ...config.enrichment,
    ...config.validation,
  ];
```

**Why these changes:**
- **Reuse core logic:** YAML/JSON loading, deprecation warnings
- **MCP extensions:** `discovery`, `backend` fields only exist in MCP
- **Logger integration:** MCP warnings use `log()` util instead of console
- **Clean separation:** Base config in core, MCP specifics in MCP package

---

### 2.5 MCP Handlers

**File:** `packages/mcp/src/handlers.ts`

**Change:** Update `analyze_project` handler to use new createPlugins signature

**Find:** (around line 200-220, wherever plugins are created)

**BEFORE:**
```typescript
const plugins: Plugin[] = [];

// Add plugins from each phase
for (const phase of ['indexing', 'analysis', 'enrichment', 'validation'] as const) {
  const names = projectConfig.plugins[phase] || [];
  plugins.push(...createPlugins(names, customPluginMap));
}
```

**AFTER:**
```typescript
const plugins = createPlugins(projectConfig.plugins, customPluginMap);
```

**Why:** Simpler, matches new signature where createPlugins handles all phases internally.

---

### 2.6 MCP Types

**File:** `packages/mcp/src/types.ts`

**Change:** Update exported type to match new MCPConfig

**Find:** `GrafemaConfig` export (if any)

**BEFORE:**
```typescript
export type GrafemaConfig = ProjectConfig;
```

**AFTER:**
```typescript
export type { GrafemaConfig } from '@grafema/core';
export type { MCPConfig } from './config.js';
```

**Why:** Export both base and MCP-specific types for external consumers.

---

## 3. Dependencies

### 3.1 CLI Package

**File:** `packages/cli/package.json`

**Add to dependencies:**

```json
{
  "dependencies": {
    "@grafema/core": "workspace:*",
    "@grafema/types": "workspace:*",
    "commander": "^13.0.0",
    "ink": "^6.6.0",
    "ink-text-input": "^6.0.0",
    "react": "^19.2.3",
    "yaml": "^2.8.2"
  }
}
```

**Why:** CLI needs `yaml` to stringify config in `init` command. Core already has it for parsing, but CLI needs it for writing.

**Note:** `@grafema/core` already has `yaml: ^2.8.2` (package.json line 50), so version must match.

---

### 3.2 Core Package

**No changes needed.** Already has `yaml: ^2.8.2` dependency.

---

### 3.3 MCP Package

**No changes needed.** Imports from `@grafema/core` which has yaml.

---

## 4. Tests

### 4.1 ConfigLoader Unit Tests

**File:** `test/unit/config/ConfigLoader.test.ts`

**Structure:**

```typescript
/**
 * ConfigLoader Tests
 *
 * Tests for shared config loading with YAML/JSON support.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { loadConfig, DEFAULT_CONFIG } from '@grafema/core';

describe('ConfigLoader', () => {
  const testDir = join(process.cwd(), 'test-fixtures', 'config-loader');
  const grafemaDir = join(testDir, '.grafema');

  beforeEach(() => {
    // Clean slate
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
    mkdirSync(grafemaDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
  });

  describe('YAML config', () => {
    it('should load valid YAML config', () => {
      const yaml = `
plugins:
  indexing:
    - JSModuleIndexer
  analysis:
    - JSASTAnalyzer
  enrichment:
    - MethodCallResolver
  validation:
    - EvalBanValidator
`;
      writeFileSync(join(grafemaDir, 'config.yaml'), yaml);

      const config = loadConfig(testDir);

      assert.deepStrictEqual(config.plugins.indexing, ['JSModuleIndexer']);
      assert.deepStrictEqual(config.plugins.analysis, ['JSASTAnalyzer']);
      assert.deepStrictEqual(config.plugins.enrichment, ['MethodCallResolver']);
      assert.deepStrictEqual(config.plugins.validation, ['EvalBanValidator']);
    });

    it('should merge partial YAML config with defaults', () => {
      const yaml = `
plugins:
  indexing:
    - CustomIndexer
`;
      writeFileSync(join(grafemaDir, 'config.yaml'), yaml);

      const config = loadConfig(testDir);

      assert.deepStrictEqual(config.plugins.indexing, ['CustomIndexer']);
      // Other phases should use defaults
      assert.deepStrictEqual(config.plugins.analysis, DEFAULT_CONFIG.plugins.analysis);
    });

    it('should handle invalid YAML gracefully', () => {
      const invalidYaml = `
plugins:
  indexing: [this is not: valid yaml
`;
      writeFileSync(join(grafemaDir, 'config.yaml'), invalidYaml);

      const warnings: string[] = [];
      const config = loadConfig(testDir, {
        warn: (msg) => warnings.push(msg),
      });

      assert.deepStrictEqual(config, DEFAULT_CONFIG, 'should return defaults on parse error');
      assert.ok(warnings.some(w => w.includes('Failed to parse')), 'should warn about parse error');
    });
  });

  describe('JSON config (deprecated)', () => {
    it('should load valid JSON config', () => {
      const json = {
        plugins: {
          indexing: ['JSModuleIndexer'],
          analysis: ['JSASTAnalyzer'],
          enrichment: ['MethodCallResolver'],
          validation: ['EvalBanValidator'],
        },
      };
      writeFileSync(join(grafemaDir, 'config.json'), JSON.stringify(json, null, 2));

      const warnings: string[] = [];
      const config = loadConfig(testDir, {
        warn: (msg) => warnings.push(msg),
      });

      assert.deepStrictEqual(config.plugins, json.plugins);
      assert.ok(warnings.some(w => w.includes('deprecated')), 'should warn about deprecated JSON');
    });

    it('should handle invalid JSON gracefully', () => {
      const invalidJson = '{ "plugins": { invalid json } }';
      writeFileSync(join(grafemaDir, 'config.json'), invalidJson);

      const warnings: string[] = [];
      const config = loadConfig(testDir, {
        warn: (msg) => warnings.push(msg),
      });

      assert.deepStrictEqual(config, DEFAULT_CONFIG);
      assert.ok(warnings.some(w => w.includes('Failed to parse')));
    });
  });

  describe('YAML takes precedence', () => {
    it('should prefer YAML when both exist', () => {
      // Write different configs
      const yaml = `
plugins:
  indexing:
    - YAMLIndexer
`;
      const json = {
        plugins: {
          indexing: ['JSONIndexer'],
        },
      };

      writeFileSync(join(grafemaDir, 'config.yaml'), yaml);
      writeFileSync(join(grafemaDir, 'config.json'), JSON.stringify(json));

      const config = loadConfig(testDir);

      assert.deepStrictEqual(config.plugins.indexing, ['YAMLIndexer'], 'YAML should win');
    });

    it('should not warn about JSON when YAML exists', () => {
      const yaml = `
plugins:
  indexing:
    - JSModuleIndexer
`;
      const json = {
        plugins: {
          indexing: ['JSModuleIndexer'],
        },
      };

      writeFileSync(join(grafemaDir, 'config.yaml'), yaml);
      writeFileSync(join(grafemaDir, 'config.json'), JSON.stringify(json));

      const warnings: string[] = [];
      loadConfig(testDir, {
        warn: (msg) => warnings.push(msg),
      });

      assert.strictEqual(warnings.length, 0, 'no warnings when YAML exists');
    });
  });

  describe('No config file', () => {
    it('should return defaults when no config exists', () => {
      const config = loadConfig(testDir);
      assert.deepStrictEqual(config, DEFAULT_CONFIG);
    });
  });

  describe('Edge cases', () => {
    it('should handle empty YAML file', () => {
      writeFileSync(join(grafemaDir, 'config.yaml'), '');

      const config = loadConfig(testDir);
      assert.deepStrictEqual(config, DEFAULT_CONFIG);
    });

    it('should handle YAML with only comments', () => {
      const yaml = `
# This is a comment
# Another comment
`;
      writeFileSync(join(grafemaDir, 'config.yaml'), yaml);

      const config = loadConfig(testDir);
      assert.deepStrictEqual(config, DEFAULT_CONFIG);
    });

    it('should handle empty plugins sections', () => {
      const yaml = `
plugins:
  indexing: []
  analysis: []
`;
      writeFileSync(join(grafemaDir, 'config.yaml'), yaml);

      const config = loadConfig(testDir);

      assert.deepStrictEqual(config.plugins.indexing, []);
      assert.deepStrictEqual(config.plugins.analysis, []);
      // Missing sections should use defaults
      assert.deepStrictEqual(config.plugins.enrichment, DEFAULT_CONFIG.plugins.enrichment);
    });
  });
});
```

**Why this structure:**
- **Matches existing patterns:** Follows Logger.test.ts structure (see lines 1-651)
- **Isolated fixtures:** Each test gets clean directory
- **Error handling:** Tests both success and failure paths
- **Logger injection:** Tests custom logger for warning capture
- **Edge cases:** Empty files, partial configs, parse errors

**Run with:**
```bash
node --import tsx --test test/unit/config/ConfigLoader.test.ts
```

---

### 4.2 E2E Test Update

**File:** `packages/cli/test/cli.test.ts`

**Change:** Verify config.yaml is created (already exists, line 221-222)

**No changes needed.** The E2E test already verifies:
```typescript
const configPath = join(e2eDir, '.grafema', 'config.yaml');
assert.ok(existsSync(configPath), '.grafema/config.yaml should be created');
```

This will continue to work after our changes. If config content validation is desired, add:

```typescript
it('should create valid YAML config', async () => {
  // After init runs...
  const configPath = join(e2eDir, '.grafema', 'config.yaml');
  const configContent = readFileSync(configPath, 'utf-8');

  // Should be valid YAML
  assert.doesNotThrow(() => {
    parseYAML(configContent);
  });

  // Should contain plugins section
  assert.ok(configContent.includes('plugins:'), 'config should have plugins section');
  assert.ok(configContent.includes('indexing:'), 'config should have indexing phase');
});
```

---

### 4.3 Init Command Test

**File:** `test/unit/cli/InitCommand.test.ts` (NEW)

**Structure:**

```typescript
/**
 * Init Command Tests
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';
import { parse as parseYAML } from 'yaml';

describe('init command', () => {
  const testDir = join(process.cwd(), 'test-fixtures', 'init-cmd');
  const cliPath = join(process.cwd(), 'packages/cli/dist/cli.js');

  function runInit(args: string[] = []): Promise<{ stdout: string; stderr: string; code: number | null }> {
    return new Promise((resolve) => {
      const proc = spawn('node', [cliPath, 'init', ...args], {
        cwd: testDir,
        env: { ...process.env, NO_COLOR: '1' },
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => { stdout += data.toString(); });
      proc.stderr.on('data', (data) => { stderr += data.toString(); });
      proc.on('close', (code) => { resolve({ stdout, stderr, code }); });
    });
  }

  beforeEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
    mkdirSync(testDir, { recursive: true });

    // Minimal package.json
    writeFileSync(
      join(testDir, 'package.json'),
      JSON.stringify({ name: 'test-project', version: '1.0.0' }, null, 2)
    );
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
  });

  it('should create config.yaml with plugins section', async () => {
    const result = await runInit();

    assert.strictEqual(result.code, 0);

    const configPath = join(testDir, '.grafema', 'config.yaml');
    assert.ok(existsSync(configPath), 'config.yaml should be created');

    const content = readFileSync(configPath, 'utf-8');
    const config = parseYAML(content);

    assert.ok(config.plugins, 'should have plugins section');
    assert.ok(Array.isArray(config.plugins.indexing), 'should have indexing array');
    assert.ok(Array.isArray(config.plugins.analysis), 'should have analysis array');
    assert.ok(Array.isArray(config.plugins.enrichment), 'should have enrichment array');
    assert.ok(Array.isArray(config.plugins.validation), 'should have validation array');
  });

  it('should NOT include unimplemented features', async () => {
    await runInit();

    const configPath = join(testDir, '.grafema', 'config.yaml');
    const content = readFileSync(configPath, 'utf-8');
    const config = parseYAML(content);

    // These should NOT be in the parsed config (only in comments)
    assert.strictEqual(config.include, undefined, 'include should not be in config');
    assert.strictEqual(config.exclude, undefined, 'exclude should not be in config');
    assert.strictEqual(config.analysis, undefined, 'analysis section should not be in config');
  });

  it('should include commented future features', async () => {
    await runInit();

    const configPath = join(testDir, '.grafema', 'config.yaml');
    const content = readFileSync(configPath, 'utf-8');

    // Comments should mention future features
    assert.ok(content.includes('# Future:'), 'should mention future features');
    assert.ok(content.includes('# include:'), 'should show include example in comments');
    assert.ok(content.includes('# exclude:'), 'should show exclude example in comments');
  });

  it('should overwrite config with --force', async () => {
    // Create initial config
    await runInit();

    // Modify config
    const configPath = join(testDir, '.grafema', 'config.yaml');
    writeFileSync(configPath, 'custom: config');

    // Run init --force
    const result = await runInit(['--force']);
    assert.strictEqual(result.code, 0);

    const content = readFileSync(configPath, 'utf-8');
    const config = parseYAML(content);

    assert.ok(config.plugins, 'config should be reset to default');
    assert.strictEqual(config.custom, undefined, 'custom field should be gone');
  });
});
```

**Why:** Ensures init creates valid, minimal, honest config.

---

## 5. Implementation Order

Execute in this order to avoid breaking changes:

### Phase 1: Foundation (Tests can run in parallel with code)
1. **Create ConfigLoader** (`packages/core/src/config/ConfigLoader.ts`)
2. **Create config index** (`packages/core/src/config/index.ts`)
3. **Update core exports** (`packages/core/src/index.ts`)
4. **Write ConfigLoader tests** (`test/unit/config/ConfigLoader.test.ts`)
5. **Run tests** — ensure ConfigLoader works standalone

### Phase 2: CLI Package
6. **Add yaml to CLI package.json**
7. **Build core** (`cd packages/core && pnpm build`)
8. **Update init command** (`packages/cli/src/commands/init.ts`)
9. **Update analyze command** (`packages/cli/src/commands/analyze.ts`)
10. **Build CLI** (`cd packages/cli && pnpm build`)
11. **Run init tests** (if created)
12. **Run E2E tests** (`cd packages/cli && pnpm test`)

### Phase 3: MCP Package
13. **Update MCP config** (`packages/mcp/src/config.ts`)
14. **Update MCP types** (`packages/mcp/src/types.ts`)
15. **Update MCP handlers** (`packages/mcp/src/handlers.ts`)
16. **Build MCP** (`cd packages/mcp && pnpm build`)

### Phase 4: Integration
17. **Verify E2E** — run full workflow (init → analyze → query)
18. **Test migration** — create config.json, verify deprecation warning
19. **Manual smoke test** — test in real project

---

## 6. Init Template

**Exact YAML content** generated by `generateConfigYAML()`:

```yaml
# Grafema Configuration
# Documentation: https://github.com/grafema/grafema#configuration

plugins:
  indexing:
    - JSModuleIndexer
  analysis:
    - JSASTAnalyzer
    - ExpressRouteAnalyzer
    - SocketIOAnalyzer
    - DatabaseAnalyzer
    - FetchAnalyzer
    - ServiceLayerAnalyzer
  enrichment:
    - MethodCallResolver
    - AliasTracker
    - ValueDomainAnalyzer
    - MountPointResolver
    - PrefixEvaluator
    - ImportExportLinker
    - HTTPConnectionEnricher
  validation:
    - CallResolverValidator
    - EvalBanValidator
    - SQLInjectionValidator
    - ShadowingDetector
    - GraphConnectivityValidator
    - DataFlowValidator
    - TypeScriptDeadCodeValidator
# Future: File discovery patterns (not yet implemented)
# Grafema currently uses entrypoint-based discovery (follows imports from package.json main field)
# Glob-based include/exclude patterns will be added in a future release
#
# include:
#   - "src/**/*.{ts,js,tsx,jsx}"
# exclude:
#   - "**/*.test.ts"
#   - "node_modules/**"
```

**User-facing features:**
- Clear, working plugin list
- Educational comments about current behavior
- Forward-looking comments for future features
- Link to documentation

**What's NOT included** (compared to current init):
- `include:` (not implemented)
- `exclude:` (not implemented)
- `analysis.maxFileSize` (not implemented)
- `analysis.timeout` (not implemented)

---

## 7. Error Messages

### 7.1 YAML Parse Error

**When:** config.yaml exists but is invalid YAML

**Message:**
```
⚠ Failed to parse config.yaml: <error details>
⚠ Using default configuration
```

**Where:** Logged via `logger.warn()`, doesn't stop execution

---

### 7.2 JSON Deprecation Warning

**When:** config.json exists but config.yaml doesn't

**Message:**
```
⚠ config.json is deprecated. Run "grafema init --force" to migrate to config.yaml
```

**Where:** Logged once when config is loaded (CLI/MCP startup)

---

### 7.3 No Config Found

**When:** Neither config.yaml nor config.json exists

**Behavior:** Silent — just uses DEFAULT_CONFIG

**Why:** Not an error. User may not have run `init` yet, or may be using defaults intentionally.

---

## 8. Migration Path

### 8.1 Automatic Detection

ConfigLoader automatically detects and handles:

1. **YAML only** → Use it (no warnings)
2. **JSON only** → Use it, warn about deprecation
3. **Both exist** → Use YAML, ignore JSON (no warnings)
4. **Neither exist** → Use defaults (no warnings)

### 8.2 Manual Migration

**Steps for users:**
```bash
# Step 1: Back up current config (optional)
cp .grafema/config.json .grafema/config.json.backup

# Step 2: Re-run init with --force
grafema init --force

# Step 3: Verify config.yaml was created
cat .grafema/config.yaml

# Step 4: Remove old config.json
rm .grafema/config.json
```

### 8.3 Future: Automated Migration Command

**Not in this PR**, but could add later:

```bash
grafema migrate-config
```

This would:
1. Read config.json
2. Convert to YAML
3. Write config.yaml
4. Rename config.json → config.json.old
5. Print migration summary

**Scope decision:** User said focus on format unification only. Migration command is enhancement.

---

## 9. Documentation Updates

### 9.1 Init Output

**Current:**
```
✓ Created .grafema/config.yaml
```

**After this PR:**
```
✓ Created .grafema/config.yaml
  → Customize plugin list in .grafema/config.yaml
  → Run "grafema analyze" to build the code graph
```

**Where:** `init.ts` line 111 (current "Next:" message)

---

### 9.2 Config File Header

**Included in generated YAML:**
```yaml
# Grafema Configuration
# Documentation: https://github.com/grafema/grafema#configuration
```

**Purpose:** Guide users to docs for advanced usage.

---

## 10. Success Criteria

After Kent and Rob implement this spec, the following must be true:

### Functional
- [ ] `grafema init` creates `config.yaml` (not `config.json`)
- [ ] Config contains only `plugins` section (no `include`/`exclude`)
- [ ] Config is valid YAML (can be parsed without errors)
- [ ] `grafema analyze` reads `config.yaml` successfully
- [ ] `grafema analyze` falls back to `config.json` with deprecation warning
- [ ] MCP server reads `config.yaml` successfully
- [ ] Default plugins match current behavior (no regression)

### Tests
- [ ] ConfigLoader unit tests pass (YAML, JSON, precedence, errors)
- [ ] E2E test passes (init → analyze → query)
- [ ] CLI tests pass (`pnpm test` in packages/cli)

### Quality
- [ ] No duplicate config loading code (removed from analyze.ts, config.ts)
- [ ] Config logic in one place (`@grafema/core/config`)
- [ ] Logger integration works (respects --quiet, --log-level)
- [ ] Clear error messages for parse failures
- [ ] Migration path documented in deprecation warning

### Non-Goals (Deferred)
- [ ] ~~`include`/`exclude` pattern support~~ (separate issue)
- [ ] ~~Glob-based file filtering~~ (separate issue)
- [ ] ~~`analysis.maxFileSize` / `timeout`~~ (separate issue)
- [ ] ~~Automated migration command~~ (future enhancement)

---

## 11. Risk Mitigation

### Risk 1: Breaking Existing Users

**Mitigation:**
- JSON fallback ensures existing setups keep working
- Clear deprecation warning with migration instructions
- E2E test verifies backward compatibility

### Risk 2: YAML Parse Errors

**Mitigation:**
- Try-catch around YAML parsing
- Fall back to defaults on error
- Clear error message with file path

### Risk 3: Type Mismatches

**Mitigation:**
- Shared `GrafemaConfig` type in `@grafema/core`
- CLI and MCP import same type
- TypeScript ensures compatibility

### Risk 4: Plugin List Drift

**Mitigation:**
- Single `DEFAULT_CONFIG` in core
- CLI, MCP, and tests all use same source
- Changes to defaults happen in one place

---

## 12. Testing Strategy

### Unit Tests
- **ConfigLoader.test.ts:** Covers all config loading scenarios
- **Run:** `node --test test/unit/config/ConfigLoader.test.ts`

### Integration Tests
- **cli.test.ts E2E:** Verifies init → analyze workflow
- **Run:** `cd packages/cli && pnpm test`

### Manual Testing
1. **Fresh project:**
   ```bash
   cd /tmp/test-grafema
   grafema init
   cat .grafema/config.yaml  # Verify content
   grafema analyze
   ```

2. **Migration path:**
   ```bash
   cd /tmp/test-grafema
   mv .grafema/config.yaml .grafema/config.json
   grafema analyze  # Should warn about deprecation
   ```

3. **Both formats exist:**
   ```bash
   cd /tmp/test-grafema
   # Create both config.yaml and config.json
   grafema analyze  # Should use YAML, no warnings
   ```

---

## 13. Implementation Checklist

For Kent and Rob to track progress:

**ConfigLoader (Core):**
- [ ] Create `packages/core/src/config/ConfigLoader.ts`
- [ ] Create `packages/core/src/config/index.ts`
- [ ] Update `packages/core/src/index.ts` exports
- [ ] Write unit tests: `test/unit/config/ConfigLoader.test.ts`
- [ ] Run tests: `node --test test/unit/config/ConfigLoader.test.ts`

**Dependencies:**
- [ ] Add `yaml` to `packages/cli/package.json`
- [ ] Run `pnpm install` in workspace root

**CLI Package:**
- [ ] Update `packages/cli/src/commands/init.ts`
  - [ ] Import yaml and DEFAULT_CONFIG
  - [ ] Replace DEFAULT_CONFIG constant with generateConfigYAML()
  - [ ] Update config writing logic
- [ ] Update `packages/cli/src/commands/analyze.ts`
  - [ ] Import loadConfig from core
  - [ ] Remove local interfaces and loadConfig function
  - [ ] Update loadConfig call to pass logger
  - [ ] Update createPlugins signature
- [ ] Build CLI: `cd packages/cli && pnpm build`
- [ ] Run CLI tests: `cd packages/cli && pnpm test`

**MCP Package:**
- [ ] Update `packages/mcp/src/config.ts`
  - [ ] Import loadConfig from core
  - [ ] Define MCPConfig type
  - [ ] Replace loadConfig function
  - [ ] Update createPlugins signature
- [ ] Update `packages/mcp/src/types.ts`
  - [ ] Export GrafemaConfig and MCPConfig
- [ ] Update `packages/mcp/src/handlers.ts`
  - [ ] Update analyze_project to use new createPlugins
- [ ] Build MCP: `cd packages/mcp && pnpm build`

**Integration Testing:**
- [ ] Run full E2E: init → analyze → query
- [ ] Test migration: config.json → deprecation warning
- [ ] Test YAML precedence: both files exist → uses YAML
- [ ] Smoke test in real project

**Documentation:**
- [ ] Update init output message (if needed)
- [ ] Verify config header comment is clear

---

## Appendix A: File Locations Summary

**New files:**
- `packages/core/src/config/ConfigLoader.ts`
- `packages/core/src/config/index.ts`
- `test/unit/config/ConfigLoader.test.ts`

**Modified files:**
- `packages/core/src/index.ts` (add exports)
- `packages/cli/package.json` (add yaml)
- `packages/cli/src/commands/init.ts` (use yaml for writing)
- `packages/cli/src/commands/analyze.ts` (use shared loader)
- `packages/mcp/src/config.ts` (use shared loader)
- `packages/mcp/src/types.ts` (export types)
- `packages/mcp/src/handlers.ts` (update createPlugins call)

**No changes:**
- `packages/cli/test/cli.test.ts` (E2E test already checks config.yaml)
- `packages/core/package.json` (yaml already present)

---

## Appendix B: Example Usage

### User Workflow After Implementation

**1. Initialize project:**
```bash
$ grafema init
✓ Found package.json
✓ Detected JavaScript project
✓ Created .grafema/config.yaml
✓ Updated .gitignore

Next: Run "grafema analyze" to build the code graph
```

**2. View config:**
```bash
$ cat .grafema/config.yaml
# Grafema Configuration
# Documentation: https://github.com/grafema/grafema#configuration

plugins:
  indexing:
    - JSModuleIndexer
  analysis:
    - JSASTAnalyzer
    - ExpressRouteAnalyzer
    ...
```

**3. Customize plugins:**
```bash
$ vim .grafema/config.yaml
# User removes validators they don't need:
plugins:
  validation:
    - EvalBanValidator
    # Removed others
```

**4. Analyze:**
```bash
$ grafema analyze
Analyzing project: /path/to/project
Loaded 15 plugins

Analysis complete in 2.34s
  Nodes: 1234
  Edges: 5678
```

**5. Migration scenario:**
```bash
$ grafema analyze
⚠ config.json is deprecated. Run "grafema init --force" to migrate to config.yaml

Analyzing project: /path/to/project
...
```

---

## Appendix C: Comparison Table

| Feature | Before (JSON) | After (YAML) |
|---------|--------------|--------------|
| **Config format** | `config.json` | `config.yaml` |
| **Created by** | N/A (manually created) | `grafema init` |
| **Loader location** | Duplicated in CLI + MCP | Shared in `@grafema/core` |
| **Plugins section** | ✅ Implemented | ✅ Implemented |
| **include/exclude** | ❌ Promised, not implemented | ⚠️ Commented (future) |
| **Migration path** | N/A | JSON fallback + warning |
| **Tests** | None | ConfigLoader.test.ts |
| **Error handling** | Silent failure | Parse errors logged |
| **User education** | None | Comments in config |

---

## Notes for Kent and Rob

**Kent (Tests):**
- ConfigLoader.test.ts is the priority
- Match existing test patterns (see Logger.test.ts for structure)
- Test both success and failure paths
- E2E test already exists, should pass after changes

**Rob (Implementation):**
- Start with ConfigLoader (foundation)
- Then CLI (init + analyze)
- Then MCP (config + handlers)
- Follow the implementation order exactly
- Build after each package modification
- Test incrementally (don't wait until the end)

**Key principle:**
This is about **format unification**, not feature addition. Remove misleading promises (include/exclude), keep what works (plugins), document the gap honestly.

If anything is unclear or you discover edge cases during implementation, flag them immediately. Don't make assumptions about config structure or behavior — stick to the spec.

Good luck! This is straightforward refactoring with clear success criteria.
