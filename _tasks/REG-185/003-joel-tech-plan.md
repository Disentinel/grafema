# REG-185: Joel Spolsky Technical Specification - Glob-based File Filtering

## Executive Summary

Implement `include`/`exclude` glob patterns as **DFS filters** in JSModuleIndexer. These patterns filter which files are processed during import traversal, not a replacement for entrypoint-based discovery.

**Key decision:** Use existing `minimatch` dependency (already in @grafema/core).

---

## Implementation Order

| Step | Component | Priority | Dependencies |
|------|-----------|----------|--------------|
| 1 | Types: Add include/exclude to interfaces | P0 | None |
| 2 | ConfigLoader: Add validation | P0 | Step 1 |
| 3 | JSModuleIndexer: Add filtering logic | P0 | Steps 1-2 |
| 4 | Init command: Update template | P1 | Step 1 |
| 5 | Tests: Unit tests for all components | P0 | Parallel with 1-4 |

---

## Step 1: Type Definitions

### File: `packages/types/src/plugins.ts`

Add `include`/`exclude` fields to `OrchestratorConfig`:

```typescript
// Line ~159, after services field
export interface OrchestratorConfig {
  projectPath: string;
  plugins?: string[];
  phases?: PluginPhase[];
  parallel?: boolean;
  maxWorkers?: number;
  verbose?: boolean;
  logLevel?: LogLevel;
  services?: ServiceDefinition[];

  // NEW: Glob patterns for file filtering during indexing
  /**
   * Glob patterns for files to include during indexing.
   * If specified, only files matching at least one pattern are processed.
   * Patterns are matched against relative paths from project root.
   * Uses minimatch syntax (e.g., "src/**/*.ts", "**/*.{js,jsx}").
   *
   * Default: undefined (process all files reachable from entrypoint)
   */
  include?: string[];

  /**
   * Glob patterns for files to exclude during indexing.
   * Files matching any pattern are skipped (not processed, imports not followed).
   * Patterns are matched against relative paths from project root.
   * Uses minimatch syntax.
   *
   * Default: undefined (no exclusions beyond npm packages)
   *
   * Note: node_modules is already excluded by default in JSModuleIndexer.
   */
  exclude?: string[];
}
```

### File: `packages/core/src/config/ConfigLoader.ts`

Add `include`/`exclude` to `GrafemaConfig` interface:

```typescript
// Line ~51, after services field
export interface GrafemaConfig {
  plugins: {
    discovery?: string[];
    indexing: string[];
    analysis: string[];
    enrichment: string[];
    validation: string[];
  };
  services: ServiceDefinition[];

  // NEW
  /**
   * Glob patterns for files to include during indexing (optional).
   * See OrchestratorConfig.include for documentation.
   */
  include?: string[];

  /**
   * Glob patterns for files to exclude during indexing (optional).
   * See OrchestratorConfig.exclude for documentation.
   */
  exclude?: string[];
}
```

Update `DEFAULT_CONFIG`:

```typescript
export const DEFAULT_CONFIG: GrafemaConfig = {
  plugins: { /* existing */ },
  services: [],
  // NEW - explicitly undefined for clarity
  include: undefined,
  exclude: undefined,
};
```

---

## Step 2: Config Validation

### File: `packages/core/src/config/ConfigLoader.ts`

Add validation function after `validateServices()`:

```typescript
/**
 * Validate include/exclude patterns.
 * THROWS on error (fail loudly per project convention).
 *
 * Validation rules:
 * 1. Must be arrays if provided
 * 2. Array elements must be non-empty strings
 * 3. Warn (don't error) if include array is empty (would exclude everything)
 *
 * @param include - Parsed include patterns (may be undefined)
 * @param exclude - Parsed exclude patterns (may be undefined)
 * @param logger - Logger for warnings
 */
function validatePatterns(
  include: unknown,
  exclude: unknown,
  logger: { warn: (msg: string) => void }
): void {
  // Validate include
  if (include !== undefined && include !== null) {
    if (!Array.isArray(include)) {
      throw new Error(`Config error: include must be an array, got ${typeof include}`);
    }
    for (let i = 0; i < include.length; i++) {
      if (typeof include[i] !== 'string') {
        throw new Error(`Config error: include[${i}] must be a string, got ${typeof include[i]}`);
      }
      if (!include[i].trim()) {
        throw new Error(`Config error: include[${i}] cannot be empty or whitespace-only`);
      }
    }
    // Warn if empty array (would exclude everything)
    if (include.length === 0) {
      logger.warn('Warning: include is an empty array - no files will be processed');
    }
  }

  // Validate exclude
  if (exclude !== undefined && exclude !== null) {
    if (!Array.isArray(exclude)) {
      throw new Error(`Config error: exclude must be an array, got ${typeof exclude}`);
    }
    for (let i = 0; i < exclude.length; i++) {
      if (typeof exclude[i] !== 'string') {
        throw new Error(`Config error: exclude[${i}] must be a string, got ${typeof exclude[i]}`);
      }
      if (!exclude[i].trim()) {
        throw new Error(`Config error: exclude[${i}] cannot be empty or whitespace-only`);
      }
    }
  }
}
```

Update `loadConfig()` to call validation (after YAML parsing, before merge):

```typescript
// After line 144 (validateServices call)
validateServices(parsed.services, projectPath);
// NEW
validatePatterns(parsed.include, parsed.exclude, logger);
```

Update `mergeConfig()` to include new fields:

```typescript
function mergeConfig(
  defaults: GrafemaConfig,
  user: Partial<GrafemaConfig>
): GrafemaConfig {
  return {
    plugins: { /* existing */ },
    services: user.services ?? defaults.services,
    // NEW
    include: user.include,  // undefined if not specified (don't merge with default)
    exclude: user.exclude,  // undefined if not specified
  };
}
```

---

## Step 3: JSModuleIndexer Filtering

### File: `packages/core/src/plugins/indexing/JSModuleIndexer.ts`

#### 3.1 Add imports

```typescript
// Line 6, add minimatch import
import { minimatch } from 'minimatch';
import { relative } from 'path';  // Already imported, verify
```

#### 3.2 Add private fields

```typescript
// Line ~77, after testPatterns field
export class JSModuleIndexer extends Plugin {
  private walker: Walker;
  private cache: Map<string, string[] | Error>;
  private testPatterns: RegExp[];
  private markTestFiles: boolean;
  // NEW
  private includePatterns?: string[];
  private excludePatterns?: string[];
  private projectPath: string = '';  // Set in execute()
```

#### 3.3 Add filtering method

```typescript
/**
 * Check if a file should be skipped based on include/exclude patterns.
 *
 * Logic:
 * 1. If file matches any exclude pattern -> SKIP
 * 2. If include patterns specified AND file doesn't match any -> SKIP
 * 3. Otherwise -> PROCESS
 *
 * @param absolutePath - Absolute path to the file
 * @returns true if file should be skipped, false if it should be processed
 */
private shouldSkipFile(absolutePath: string): boolean {
  // Normalize to relative path for pattern matching
  const relativePath = relative(this.projectPath, absolutePath).replace(/\\/g, '/');

  // Check exclude patterns first (if any match, skip)
  if (this.excludePatterns && this.excludePatterns.length > 0) {
    for (const pattern of this.excludePatterns) {
      if (minimatch(relativePath, pattern, { dot: true })) {
        return true;  // Excluded
      }
    }
  }

  // Check include patterns (if specified, file must match at least one)
  if (this.includePatterns && this.includePatterns.length > 0) {
    for (const pattern of this.includePatterns) {
      if (minimatch(relativePath, pattern, { dot: true })) {
        return false;  // Included
      }
    }
    return true;  // Include specified but file didn't match any
  }

  return false;  // No filtering, process file
}
```

#### 3.4 Update execute() to read patterns from config

Update the `execute()` method around line 217:

```typescript
async execute(context: PluginContext): Promise<PluginResult> {
  const logger = this.log(context);
  try {
    const { graph, onProgress, config } = context;
    const manifest = context.manifest as IndexerManifest | undefined;
    const projectPath = manifest?.projectPath ?? '';
    const service = manifest?.service ?? { id: '', name: '', path: '' };

    // Collect parse errors
    const parseErrors: Error[] = [];

    // Store projectPath for shouldSkipFile()
    this.projectPath = projectPath;

    // Read include/exclude patterns from config
    // Config type is OrchestratorConfig but typed as unknown in context
    const orchConfig = config as { include?: string[]; exclude?: string[] } | undefined;
    this.includePatterns = orchConfig?.include;
    this.excludePatterns = orchConfig?.exclude;

    // Log if patterns are configured
    if (this.includePatterns || this.excludePatterns) {
      logger.info('File filtering enabled', {
        include: this.includePatterns?.length ?? 0,
        exclude: this.excludePatterns?.length ?? 0,
      });
    }

    // ... rest of existing code
```

#### 3.5 Apply filtering in DFS loop

In the DFS while loop (around line 260), add filtering check right after popping from stack:

```typescript
while (stack.length > 0 && visited.size < MAX_MODULES) {
  const { file: currentFile, depth } = stack.pop()!;

  // NEW: Check if file should be skipped based on include/exclude patterns
  if (this.shouldSkipFile(currentFile)) {
    logger.debug('Skipping file (filtered by patterns)', {
      file: currentFile.replace(projectPath, '')
    });
    continue;  // Don't process, don't follow imports
  }

  // Report progress every PROGRESS_INTERVAL files
  // ... rest of existing loop
```

#### 3.6 Track skipped files in result metadata

Update the result to include filtering stats:

```typescript
// After the while loop, before creating result
let skippedByPatterns = 0;
// (Track this by incrementing in the skip logic above)

// In result metadata:
return {
  success: true,
  created: { nodes: nodesCreated, edges: edgesCreated },
  errors: parseErrors,
  warnings: [],
  metadata: {
    totalModules: visited.size,
    // NEW
    skippedByPatterns,
    hasFiltering: Boolean(this.includePatterns || this.excludePatterns),
  },
};
```

---

## Step 4: Init Command Template

### File: `packages/cli/src/commands/init.ts`

Update `generateConfigYAML()` function (line ~21):

```typescript
function generateConfigYAML(): string {
  // Start with working default config
  const config = {
    plugins: DEFAULT_CONFIG.plugins,
  };

  // Convert to YAML
  const yaml = stringifyYAML(config, {
    lineWidth: 0,
  });

  // Add header and documented include/exclude
  return `# Grafema Configuration
# Documentation: https://github.com/grafema/grafema#configuration

${yaml}
# File filtering (optional)
# Control which files are processed during analysis.
# Patterns use glob syntax (minimatch) and match against paths relative to project root.
#
# include:
#   - "src/**/*.{ts,js,tsx,jsx}"   # Only process files under src/
#   - "lib/**/*.ts"                 # Also include lib/
#
# exclude:
#   - "**/*.test.ts"               # Skip test files
#   - "**/*.spec.ts"               # Skip spec files
#   - "**/fixtures/**"             # Skip fixture directories
#   - "**/__mocks__/**"            # Skip mock directories
#
# If include is specified, only matching files are processed.
# If exclude is specified, matching files are skipped.
# Both can be used together: include filters first, then exclude.
# Default: no filtering (all files reachable from entrypoint are processed)
`;
}
```

---

## Step 5: Test Cases

### File: `test/unit/config/ConfigLoader.test.ts`

Add new describe block for include/exclude validation:

```typescript
// ===========================================================================
// TESTS: Include/Exclude patterns (REG-185)
// ===========================================================================

describe('Include/Exclude patterns', () => {
  // Valid patterns
  it('should load include patterns from YAML', () => {
    const yaml = `include:
  - "src/**/*.ts"
  - "lib/**/*.js"
`;
    writeFileSync(join(grafemaDir, 'config.yaml'), yaml);

    const config = loadConfig(testDir);

    assert.deepStrictEqual(config.include, ['src/**/*.ts', 'lib/**/*.js']);
    assert.strictEqual(config.exclude, undefined);
  });

  it('should load exclude patterns from YAML', () => {
    const yaml = `exclude:
  - "**/*.test.ts"
  - "**/fixtures/**"
`;
    writeFileSync(join(grafemaDir, 'config.yaml'), yaml);

    const config = loadConfig(testDir);

    assert.strictEqual(config.include, undefined);
    assert.deepStrictEqual(config.exclude, ['**/*.test.ts', '**/fixtures/**']);
  });

  it('should load both include and exclude patterns', () => {
    const yaml = `include:
  - "src/**/*.ts"
exclude:
  - "**/*.test.ts"
`;
    writeFileSync(join(grafemaDir, 'config.yaml'), yaml);

    const config = loadConfig(testDir);

    assert.deepStrictEqual(config.include, ['src/**/*.ts']);
    assert.deepStrictEqual(config.exclude, ['**/*.test.ts']);
  });

  it('should return undefined for include/exclude when not specified', () => {
    const yaml = `plugins:
  indexing:
    - JSModuleIndexer
`;
    writeFileSync(join(grafemaDir, 'config.yaml'), yaml);

    const config = loadConfig(testDir);

    assert.strictEqual(config.include, undefined);
    assert.strictEqual(config.exclude, undefined);
  });

  // Validation errors
  it('should throw error when include is not an array', () => {
    const yaml = `include: "not an array"
`;
    writeFileSync(join(grafemaDir, 'config.yaml'), yaml);

    assert.throws(
      () => loadConfig(testDir),
      /include must be an array/
    );
  });

  it('should throw error when exclude is not an array', () => {
    const yaml = `exclude: { not: "an array" }
`;
    writeFileSync(join(grafemaDir, 'config.yaml'), yaml);

    assert.throws(
      () => loadConfig(testDir),
      /exclude must be an array/
    );
  });

  it('should throw error when include pattern is not a string', () => {
    const yaml = `include:
  - "valid pattern"
  - 123
`;
    writeFileSync(join(grafemaDir, 'config.yaml'), yaml);

    assert.throws(
      () => loadConfig(testDir),
      /include\[1\] must be a string/
    );
  });

  it('should throw error when exclude pattern is empty string', () => {
    const yaml = `exclude:
  - ""
`;
    writeFileSync(join(grafemaDir, 'config.yaml'), yaml);

    assert.throws(
      () => loadConfig(testDir),
      /exclude\[0\] cannot be empty/
    );
  });

  it('should throw error when include pattern is whitespace-only', () => {
    const yaml = `include:
  - "   "
`;
    writeFileSync(join(grafemaDir, 'config.yaml'), yaml);

    assert.throws(
      () => loadConfig(testDir),
      /include\[0\] cannot be empty or whitespace-only/
    );
  });

  // Warning for empty include
  it('should warn when include is empty array', () => {
    const yaml = `include: []
`;
    writeFileSync(join(grafemaDir, 'config.yaml'), yaml);

    const logger = createLoggerMock();
    const config = loadConfig(testDir, logger);

    assert.deepStrictEqual(config.include, []);
    assert.ok(
      logger.warnings.some(w => w.includes('empty array')),
      'should warn about empty include array'
    );
  });

  // Edge cases
  it('should accept complex glob patterns', () => {
    const yaml = `include:
  - "src/**/*.{ts,tsx,js,jsx}"
  - "packages/*/src/**"
  - "!**/node_modules/**"
exclude:
  - "**/__tests__/**"
  - "**/*.d.ts"
`;
    writeFileSync(join(grafemaDir, 'config.yaml'), yaml);

    const config = loadConfig(testDir);

    assert.strictEqual(config.include?.length, 3);
    assert.strictEqual(config.exclude?.length, 2);
  });
});
```

### File: `test/unit/plugins/indexing/JSModuleIndexer.test.ts`

Add new describe block for filtering:

```typescript
// ===========================================================================
// TESTS: Include/Exclude Pattern Filtering (REG-185)
// ===========================================================================

describe('Include/Exclude Pattern Filtering (REG-185)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'grafema-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  /**
   * Create context with include/exclude config
   */
  function createFilteringContext(
    projectPath: string,
    entryPath: string,
    include?: string[],
    exclude?: string[],
    graph?: MockGraphBackend
  ): PluginContext {
    return {
      graph: (graph ?? new MockGraphBackend()) as unknown as GraphBackend,
      manifest: {
        projectPath,
        service: {
          id: 'test-service',
          name: 'TestService',
          path: entryPath,
        },
      },
      config: { include, exclude },
      phase: 'INDEXING',
    };
  }

  // --- Exclude patterns ---

  it('should skip files matching exclude patterns', async () => {
    // Setup: entry.js imports test.js and util.js
    writeFileSync(join(tempDir, 'entry.js'), `
      import './test.js';
      import './util.js';
    `);
    writeFileSync(join(tempDir, 'test.js'), 'export const test = 1;');
    writeFileSync(join(tempDir, 'util.js'), 'export const util = 2;');

    const graph = new MockGraphBackend();
    const indexer = new JSModuleIndexer();
    const result = await indexer.execute(
      createFilteringContext(tempDir, 'entry.js', undefined, ['**/*.test.js', '**/test.js'], graph)
    );

    // Verify: test.js skipped, util.js processed
    assert.strictEqual(result.success, true);
    const nodeIds = Array.from(graph.nodes.keys());

    assert.ok(
      nodeIds.some(id => id.includes('entry.js')),
      'entry.js should be indexed'
    );
    assert.ok(
      nodeIds.some(id => id.includes('util.js')),
      'util.js should be indexed'
    );
    assert.ok(
      !nodeIds.some(id => id.includes('test.js')),
      'test.js should NOT be indexed (excluded)'
    );
  });

  it('should skip entire directory with exclude pattern', async () => {
    // Setup: entry.js imports from fixtures/
    mkdirSync(join(tempDir, 'fixtures'), { recursive: true });

    writeFileSync(join(tempDir, 'entry.js'), `
      import './fixtures/data.js';
      import './util.js';
    `);
    writeFileSync(join(tempDir, 'fixtures', 'data.js'), 'export const data = 1;');
    writeFileSync(join(tempDir, 'util.js'), 'export const util = 2;');

    const graph = new MockGraphBackend();
    const indexer = new JSModuleIndexer();
    const result = await indexer.execute(
      createFilteringContext(tempDir, 'entry.js', undefined, ['**/fixtures/**'], graph)
    );

    // Verify: fixtures/data.js skipped
    assert.strictEqual(result.success, true);
    const nodeIds = Array.from(graph.nodes.keys());

    assert.ok(!nodeIds.some(id => id.includes('fixtures')), 'fixtures/ should be excluded');
    assert.ok(nodeIds.some(id => id.includes('util.js')), 'util.js should be indexed');
  });

  // --- Include patterns ---

  it('should only process files matching include patterns', async () => {
    // Setup: entry.js imports from src/ and lib/
    mkdirSync(join(tempDir, 'src'), { recursive: true });
    mkdirSync(join(tempDir, 'lib'), { recursive: true });

    writeFileSync(join(tempDir, 'entry.js'), `
      import './src/util.js';
      import './lib/helper.js';
    `);
    writeFileSync(join(tempDir, 'src', 'util.js'), 'export const util = 1;');
    writeFileSync(join(tempDir, 'lib', 'helper.js'), 'export const helper = 2;');

    const graph = new MockGraphBackend();
    const indexer = new JSModuleIndexer();
    const result = await indexer.execute(
      createFilteringContext(tempDir, 'entry.js', ['entry.js', 'src/**/*.js'], undefined, graph)
    );

    // Verify: only entry.js and src/util.js processed
    assert.strictEqual(result.success, true);
    const nodeIds = Array.from(graph.nodes.keys());

    assert.ok(nodeIds.some(id => id.includes('entry.js')), 'entry.js should be indexed');
    assert.ok(nodeIds.some(id => id.includes('src/util.js') || id.includes('src\\util.js')), 'src/util.js should be indexed');
    assert.ok(!nodeIds.some(id => id.includes('lib/helper.js') || id.includes('lib\\helper.js')), 'lib/helper.js should NOT be indexed');
  });

  // --- Combined include + exclude ---

  it('should apply exclude after include', async () => {
    // Setup: Include src/, but exclude test files within src/
    mkdirSync(join(tempDir, 'src'), { recursive: true });

    writeFileSync(join(tempDir, 'entry.js'), `
      import './src/util.js';
      import './src/util.test.js';
    `);
    writeFileSync(join(tempDir, 'src', 'util.js'), 'export const util = 1;');
    writeFileSync(join(tempDir, 'src', 'util.test.js'), 'export const test = 2;');

    const graph = new MockGraphBackend();
    const indexer = new JSModuleIndexer();
    const result = await indexer.execute(
      createFilteringContext(
        tempDir,
        'entry.js',
        ['entry.js', 'src/**/*.js'],  // include src/
        ['**/*.test.js'],              // but exclude .test.js
        graph
      )
    );

    // Verify: util.js included, util.test.js excluded
    assert.strictEqual(result.success, true);
    const nodeIds = Array.from(graph.nodes.keys());

    assert.ok(nodeIds.some(id => id.includes('util.js') && !id.includes('.test')), 'util.js should be indexed');
    assert.ok(!nodeIds.some(id => id.includes('util.test.js')), 'util.test.js should NOT be indexed');
  });

  // --- No filtering (default behavior) ---

  it('should process all reachable files when no patterns specified', async () => {
    writeFileSync(join(tempDir, 'entry.js'), `
      import './a.js';
      import './b.js';
    `);
    writeFileSync(join(tempDir, 'a.js'), 'export const a = 1;');
    writeFileSync(join(tempDir, 'b.js'), 'export const b = 2;');

    const graph = new MockGraphBackend();
    const indexer = new JSModuleIndexer();
    const result = await indexer.execute(
      createFilteringContext(tempDir, 'entry.js', undefined, undefined, graph)
    );

    // Verify: all files processed
    assert.strictEqual(result.success, true);
    const nodeIds = Array.from(graph.nodes.keys());

    assert.ok(nodeIds.length >= 3, 'should have at least 3 nodes');
    assert.ok(nodeIds.some(id => id.includes('entry.js')));
    assert.ok(nodeIds.some(id => id.includes('a.js')));
    assert.ok(nodeIds.some(id => id.includes('b.js')));
  });

  // --- Edge cases ---

  it('should handle brace expansion in patterns', async () => {
    // Pattern: **/*.{ts,js}
    writeFileSync(join(tempDir, 'entry.js'), `
      import './util.ts';
      import './helper.jsx';
    `);
    writeFileSync(join(tempDir, 'util.ts'), 'export const util = 1;');
    writeFileSync(join(tempDir, 'helper.jsx'), 'export const helper = 2;');

    const graph = new MockGraphBackend();
    const indexer = new JSModuleIndexer();
    const result = await indexer.execute(
      createFilteringContext(tempDir, 'entry.js', ['**/*.{js,ts}'], undefined, graph)
    );

    // Verify: .js and .ts included, .jsx excluded
    const nodeIds = Array.from(graph.nodes.keys());

    assert.ok(nodeIds.some(id => id.includes('entry.js')));
    assert.ok(nodeIds.some(id => id.includes('util.ts')));
    assert.ok(!nodeIds.some(id => id.includes('helper.jsx')), '.jsx should not match {js,ts}');
  });

  it('should skip entrypoint itself if excluded', async () => {
    // Edge case: what if entrypoint matches exclude?
    // Behavior: entry should still be processed (it's the starting point)
    // But we should verify this behavior is intentional
    writeFileSync(join(tempDir, 'entry.test.js'), 'export const x = 1;');

    const graph = new MockGraphBackend();
    const indexer = new JSModuleIndexer();
    const result = await indexer.execute(
      createFilteringContext(tempDir, 'entry.test.js', undefined, ['**/*.test.js'], graph)
    );

    // Note: Current implementation WILL skip the entrypoint if it matches exclude.
    // This test documents that behavior. If we want entrypoint always processed,
    // we need to add special handling.
    const nodeIds = Array.from(graph.nodes.keys());

    // The entrypoint IS skipped if it matches exclude - this is the documented behavior
    assert.strictEqual(nodeIds.length, 0, 'entrypoint matching exclude should be skipped');
  });

  it('should normalize Windows paths for pattern matching', async () => {
    // This test ensures cross-platform compatibility
    mkdirSync(join(tempDir, 'src'), { recursive: true });

    writeFileSync(join(tempDir, 'entry.js'), 'import "./src/util.js";');
    writeFileSync(join(tempDir, 'src', 'util.js'), 'export const util = 1;');

    const graph = new MockGraphBackend();
    const indexer = new JSModuleIndexer();

    // Pattern uses forward slashes (standard glob syntax)
    const result = await indexer.execute(
      createFilteringContext(tempDir, 'entry.js', ['**/*.js'], undefined, graph)
    );

    assert.strictEqual(result.success, true);
    const nodeIds = Array.from(graph.nodes.keys());
    assert.ok(nodeIds.length >= 2, 'should process files regardless of OS path separators');
  });
});
```

---

## Acceptance Criteria Checklist

### Functionality
- [ ] `include` patterns filter which files are processed during DFS
- [ ] `exclude` patterns skip matching files during DFS
- [ ] Patterns use minimatch syntax (globs with `**`, `*`, `{a,b}`)
- [ ] Patterns match against paths relative to project root
- [ ] No patterns = current behavior (all reachable files)
- [ ] Empty `include` array warns but doesn't error
- [ ] Invalid patterns (not array, not strings, empty strings) throw errors

### Backward Compatibility
- [ ] No config changes = current behavior preserved
- [ ] Existing configs without include/exclude continue to work
- [ ] DEFAULT_CONFIG has undefined (not empty arrays) for include/exclude

### Code Quality
- [ ] All new code has JSDoc comments
- [ ] Test coverage for all new functionality
- [ ] No new dependencies (uses existing minimatch)
- [ ] Matches existing code patterns in the codebase

### Documentation
- [ ] Init template updated with documented patterns
- [ ] Comments in types explain the feature

---

## Edge Case Behaviors (Documented)

| Scenario | Behavior |
|----------|----------|
| Entrypoint matches exclude | Entrypoint is skipped (no special handling) |
| File matches both include and exclude | Excluded (exclude wins) |
| Include is empty array `[]` | Warning logged, no files processed |
| Include is undefined | No include filtering (process all) |
| Exclude is empty array `[]` | No exclude filtering (process all) |
| Pattern with Windows backslashes | Normalized to forward slashes |
| node_modules import | Already handled separately (package::\*) |

---

## Implementation Notes for Rob

1. **Order matters**: Check exclude before include in `shouldSkipFile()` - it's more efficient and matches user expectation that exclude "wins".

2. **Pattern compilation**: minimatch can pre-compile patterns with `new Minimatch(pattern)`. Consider this optimization if performance testing shows pattern matching is a bottleneck. For v1, simple `minimatch()` calls are fine.

3. **Debug logging**: Add debug-level logs when files are skipped to help users troubleshoot patterns.

4. **Result metadata**: Track `skippedByPatterns` count for observability (useful for verbose mode).

5. **Path normalization**: Always use forward slashes for pattern matching, even on Windows. The `relative()` path should be normalized with `.replace(/\\/g, '/')`.

6. **Don't forget `{ dot: true }`**: Pass this option to minimatch so patterns can match dotfiles (e.g., `.eslintrc.js`).
