/**
 * ConfigLoader Tests
 *
 * Tests for shared config loading with YAML/JSON support.
 * Based on specification: _tasks/2025-01-24-reg-170-config-yaml-json-incompatibility/003-joel-tech-plan.md
 *
 * Tests:
 * - YAML config loading (valid, partial, invalid)
 * - JSON config loading (deprecated, valid, invalid)
 * - YAML takes precedence over JSON
 * - No config returns defaults
 * - Edge cases (empty file, comments only, empty arrays)
 * - Logger injection for warning capture
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { loadConfig, DEFAULT_CONFIG } from '@grafema/core';

// =============================================================================
// Test Helpers
// =============================================================================

/**
 * Captures warnings from logger during test execution
 */
interface LoggerMock {
  warnings: string[];
  warn: (msg: string) => void;
}

function createLoggerMock(): LoggerMock {
  const warnings: string[] = [];
  return {
    warnings,
    warn: (msg: string) => warnings.push(msg),
  };
}

// =============================================================================
// TESTS: ConfigLoader
// =============================================================================

describe('ConfigLoader', () => {
  const testDir = join(process.cwd(), 'test-fixtures', 'config-loader');
  const grafemaDir = join(testDir, '.grafema');

  beforeEach(() => {
    // Clean slate for each test
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

  // ===========================================================================
  // TESTS: YAML config
  // ===========================================================================

  describe('YAML config', () => {
    it('should load valid YAML config', () => {
      const yaml = `plugins:
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
      const yaml = `plugins:
  indexing:
    - CustomIndexer
`;
      writeFileSync(join(grafemaDir, 'config.yaml'), yaml);

      const config = loadConfig(testDir);

      assert.deepStrictEqual(config.plugins.indexing, ['CustomIndexer']);
      // Other phases should use defaults
      assert.deepStrictEqual(config.plugins.analysis, DEFAULT_CONFIG.plugins.analysis);
      assert.deepStrictEqual(config.plugins.enrichment, DEFAULT_CONFIG.plugins.enrichment);
      assert.deepStrictEqual(config.plugins.validation, DEFAULT_CONFIG.plugins.validation);
    });

    it('should handle invalid YAML gracefully', () => {
      const invalidYaml = `plugins:
  indexing: [this is not: valid yaml
`;
      writeFileSync(join(grafemaDir, 'config.yaml'), invalidYaml);

      const logger = createLoggerMock();
      const config = loadConfig(testDir, logger);

      assert.deepStrictEqual(config, DEFAULT_CONFIG, 'should return defaults on parse error');
      assert.ok(logger.warnings.some(w => w.includes('Failed to parse')), 'should warn about parse error');
      assert.ok(logger.warnings.some(w => w.includes('Using default configuration')), 'should inform about using defaults');
    });

    it('should handle YAML parse errors with detailed message', () => {
      const invalidYaml = `plugins:
  indexing:
    - Plugin1
  analysis: not a valid array syntax {
`;
      writeFileSync(join(grafemaDir, 'config.yaml'), invalidYaml);

      const logger = createLoggerMock();
      const config = loadConfig(testDir, logger);

      assert.deepStrictEqual(config, DEFAULT_CONFIG);
      assert.strictEqual(logger.warnings.length, 2, 'should have exactly 2 warnings');
      assert.ok(logger.warnings[0].includes('Failed to parse config.yaml'));
    });
  });

  // ===========================================================================
  // TESTS: JSON config (deprecated)
  // ===========================================================================

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

      const logger = createLoggerMock();
      const config = loadConfig(testDir, logger);

      assert.deepStrictEqual(config.plugins.indexing, json.plugins.indexing);
      assert.deepStrictEqual(config.plugins.analysis, json.plugins.analysis);
      assert.deepStrictEqual(config.plugins.enrichment, json.plugins.enrichment);
      assert.deepStrictEqual(config.plugins.validation, json.plugins.validation);
      assert.deepStrictEqual(config.plugins.discovery, [], 'discovery defaults to empty array');
      assert.ok(logger.warnings.some(w => w.includes('deprecated')), 'should warn about deprecated JSON');
      assert.ok(logger.warnings.some(w => w.includes('grafema init --force')), 'should mention migration command');
    });

    it('should handle invalid JSON gracefully', () => {
      const invalidJson = '{ "plugins": { invalid json } }';
      writeFileSync(join(grafemaDir, 'config.json'), invalidJson);

      const logger = createLoggerMock();
      const config = loadConfig(testDir, logger);

      assert.deepStrictEqual(config, DEFAULT_CONFIG, 'should return defaults on parse error');
      assert.ok(logger.warnings.some(w => w.includes('Failed to parse')), 'should warn about parse error');
    });

    it('should merge partial JSON config with defaults', () => {
      const json = {
        plugins: {
          indexing: ['CustomIndexer'],
        },
      };
      writeFileSync(join(grafemaDir, 'config.json'), JSON.stringify(json));

      const logger = createLoggerMock();
      const config = loadConfig(testDir, logger);

      assert.deepStrictEqual(config.plugins.indexing, ['CustomIndexer']);
      // Other phases should use defaults
      assert.deepStrictEqual(config.plugins.analysis, DEFAULT_CONFIG.plugins.analysis);
    });
  });

  // ===========================================================================
  // TESTS: YAML takes precedence
  // ===========================================================================

  describe('YAML takes precedence', () => {
    it('should prefer YAML when both exist', () => {
      // Write different configs
      const yaml = `plugins:
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
      const yaml = `plugins:
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

      const logger = createLoggerMock();
      loadConfig(testDir, logger);

      assert.strictEqual(logger.warnings.length, 0, 'no warnings when YAML exists');
    });

    it('should use YAML even if it has different structure than JSON', () => {
      const yaml = `plugins:
  indexing:
    - YAMLIndexer1
    - YAMLIndexer2
  analysis:
    - YAMLAnalyzer
`;
      const json = {
        plugins: {
          indexing: ['JSONIndexer'],
          analysis: ['JSONAnalyzer1', 'JSONAnalyzer2', 'JSONAnalyzer3'],
        },
      };

      writeFileSync(join(grafemaDir, 'config.yaml'), yaml);
      writeFileSync(join(grafemaDir, 'config.json'), JSON.stringify(json));

      const config = loadConfig(testDir);

      assert.deepStrictEqual(config.plugins.indexing, ['YAMLIndexer1', 'YAMLIndexer2']);
      assert.deepStrictEqual(config.plugins.analysis, ['YAMLAnalyzer']);
      // Defaults for sections not in YAML
      assert.deepStrictEqual(config.plugins.enrichment, DEFAULT_CONFIG.plugins.enrichment);
    });
  });

  // ===========================================================================
  // TESTS: No config file
  // ===========================================================================

  describe('No config file', () => {
    it('should return defaults when no config exists', () => {
      const config = loadConfig(testDir);
      assert.deepStrictEqual(config, DEFAULT_CONFIG);
    });

    it('should not warn when no config exists', () => {
      const logger = createLoggerMock();
      loadConfig(testDir, logger);
      assert.strictEqual(logger.warnings.length, 0, 'should not warn when no config');
    });

    it('should return defaults when .grafema directory does not exist', () => {
      const nonExistentDir = join(testDir, 'nonexistent');
      const config = loadConfig(nonExistentDir);
      assert.deepStrictEqual(config, DEFAULT_CONFIG);
    });
  });

  // ===========================================================================
  // TESTS: Edge cases
  // ===========================================================================

  describe('Edge cases', () => {
    it('should handle empty YAML file', () => {
      writeFileSync(join(grafemaDir, 'config.yaml'), '');

      const config = loadConfig(testDir);
      assert.deepStrictEqual(config, DEFAULT_CONFIG, 'empty file should return defaults');
    });

    it('should handle YAML with only comments', () => {
      const yaml = `# This is a comment
# Another comment
# No actual config here
`;
      writeFileSync(join(grafemaDir, 'config.yaml'), yaml);

      const config = loadConfig(testDir);
      assert.deepStrictEqual(config, DEFAULT_CONFIG, 'comments-only file should return defaults');
    });

    it('should handle empty plugins sections', () => {
      const yaml = `plugins:
  indexing: []
  analysis: []
`;
      writeFileSync(join(grafemaDir, 'config.yaml'), yaml);

      const config = loadConfig(testDir);

      assert.deepStrictEqual(config.plugins.indexing, [], 'should respect empty array');
      assert.deepStrictEqual(config.plugins.analysis, [], 'should respect empty array');
      // Missing sections should use defaults
      assert.deepStrictEqual(config.plugins.enrichment, DEFAULT_CONFIG.plugins.enrichment);
      assert.deepStrictEqual(config.plugins.validation, DEFAULT_CONFIG.plugins.validation);
    });

    it('should handle YAML with extra whitespace', () => {
      const yaml = `


plugins:

  indexing:
    - JSModuleIndexer


  analysis:
    - JSASTAnalyzer

`;
      writeFileSync(join(grafemaDir, 'config.yaml'), yaml);

      const config = loadConfig(testDir);

      assert.deepStrictEqual(config.plugins.indexing, ['JSModuleIndexer']);
      assert.deepStrictEqual(config.plugins.analysis, ['JSASTAnalyzer']);
    });

    it('should handle YAML with inline array syntax', () => {
      const yaml = `plugins:
  indexing: [JSModuleIndexer]
  analysis: [JSASTAnalyzer, ExpressRouteAnalyzer]
`;
      writeFileSync(join(grafemaDir, 'config.yaml'), yaml);

      const config = loadConfig(testDir);

      assert.deepStrictEqual(config.plugins.indexing, ['JSModuleIndexer']);
      assert.deepStrictEqual(config.plugins.analysis, ['JSASTAnalyzer', 'ExpressRouteAnalyzer']);
    });

    it('should handle YAML with mixed comments and config', () => {
      const yaml = `# Grafema Configuration
plugins:
  # Indexing phase
  indexing:
    - JSModuleIndexer
  # Analysis phase
  analysis:
    - JSASTAnalyzer  # Main analyzer
`;
      writeFileSync(join(grafemaDir, 'config.yaml'), yaml);

      const config = loadConfig(testDir);

      assert.deepStrictEqual(config.plugins.indexing, ['JSModuleIndexer']);
      assert.deepStrictEqual(config.plugins.analysis, ['JSASTAnalyzer']);
    });

    it('should handle null values in partial config', () => {
      const yaml = `plugins:
  indexing:
  analysis: []
`;
      writeFileSync(join(grafemaDir, 'config.yaml'), yaml);

      const config = loadConfig(testDir);

      // null should fall back to defaults
      assert.deepStrictEqual(config.plugins.indexing, DEFAULT_CONFIG.plugins.indexing);
      // Empty array should be respected
      assert.deepStrictEqual(config.plugins.analysis, []);
    });
  });

  // ===========================================================================
  // TESTS: Logger injection
  // ===========================================================================

  describe('Logger injection', () => {
    it('should use provided logger for warnings', () => {
      const json = {
        plugins: {
          indexing: ['JSModuleIndexer'],
        },
      };
      writeFileSync(join(grafemaDir, 'config.json'), JSON.stringify(json));

      const logger = createLoggerMock();
      loadConfig(testDir, logger);

      assert.ok(logger.warnings.length > 0, 'should call custom logger');
      assert.ok(logger.warnings[0].includes('deprecated'));
    });

    it('should use default console when no logger provided', () => {
      const json = {
        plugins: {
          indexing: ['JSModuleIndexer'],
        },
      };
      writeFileSync(join(grafemaDir, 'config.json'), JSON.stringify(json));

      // Should not throw when using default console
      assert.doesNotThrow(() => {
        loadConfig(testDir);
      }, 'should work with default console logger');
    });

    it('should pass error details to logger', () => {
      const invalidYaml = 'invalid: yaml: syntax: [[[';
      writeFileSync(join(grafemaDir, 'config.yaml'), invalidYaml);

      const logger = createLoggerMock();
      loadConfig(testDir, logger);

      assert.ok(logger.warnings[0].includes('Failed to parse config.yaml:'));
      // Error message should be included
      assert.ok(logger.warnings[0].length > 'Failed to parse config.yaml: '.length);
    });
  });

  // ===========================================================================
  // TESTS: Discovery phase
  // ===========================================================================

  describe('Discovery phase', () => {
    it('should parse discovery plugins from YAML', () => {
      const yaml = `plugins:
  discovery:
    - WorkspaceDiscovery
    - MonorepoServiceDiscovery
  indexing:
    - JSModuleIndexer
`;
      writeFileSync(join(grafemaDir, 'config.yaml'), yaml);

      const config = loadConfig(testDir);

      assert.deepStrictEqual(config.plugins.discovery, ['WorkspaceDiscovery', 'MonorepoServiceDiscovery']);
    });

    it('should use empty array as default for discovery', () => {
      const yaml = `plugins:
  indexing:
    - JSModuleIndexer
`;
      writeFileSync(join(grafemaDir, 'config.yaml'), yaml);

      const config = loadConfig(testDir);

      assert.deepStrictEqual(config.plugins.discovery, []);
    });

    it('DEFAULT_CONFIG should have discovery field', () => {
      assert.ok(Array.isArray(DEFAULT_CONFIG.plugins.discovery));
      assert.deepStrictEqual(DEFAULT_CONFIG.plugins.discovery, []);
    });
  });

  // ===========================================================================
  // TESTS: DEFAULT_CONFIG structure
  // ===========================================================================

  describe('DEFAULT_CONFIG', () => {
    it('should have all required plugin phases', () => {
      assert.ok(Array.isArray(DEFAULT_CONFIG.plugins.indexing));
      assert.ok(Array.isArray(DEFAULT_CONFIG.plugins.analysis));
      assert.ok(Array.isArray(DEFAULT_CONFIG.plugins.enrichment));
      assert.ok(Array.isArray(DEFAULT_CONFIG.plugins.validation));
    });

    it('should have non-empty default plugins', () => {
      assert.ok(DEFAULT_CONFIG.plugins.indexing.length > 0, 'indexing should have default plugins');
      assert.ok(DEFAULT_CONFIG.plugins.analysis.length > 0, 'analysis should have default plugins');
      assert.ok(DEFAULT_CONFIG.plugins.enrichment.length > 0, 'enrichment should have default plugins');
      assert.ok(DEFAULT_CONFIG.plugins.validation.length > 0, 'validation should have default plugins');
    });

    it('should include expected default plugins', () => {
      // Based on Joel's spec
      assert.ok(DEFAULT_CONFIG.plugins.indexing.includes('JSModuleIndexer'));
      assert.ok(DEFAULT_CONFIG.plugins.analysis.includes('JSASTAnalyzer'));
      assert.ok(DEFAULT_CONFIG.plugins.enrichment.includes('MethodCallResolver'));
      assert.ok(DEFAULT_CONFIG.plugins.validation.includes('EvalBanValidator'));
    });
  });

  // ===========================================================================
  // TESTS: Services configuration (REG-174)
  // ===========================================================================

  describe('Services configuration', () => {
    // -------------------------------------------------------------------------
    // Valid services loading
    // -------------------------------------------------------------------------

    it('should load services from YAML config', () => {
      // Create service directories that the config references
      mkdirSync(join(testDir, 'apps', 'backend'), { recursive: true });
      mkdirSync(join(testDir, 'apps', 'frontend'), { recursive: true });

      const yaml = `plugins:
  indexing:
    - JSModuleIndexer
  analysis:
    - JSASTAnalyzer
  enrichment:
    - MethodCallResolver
  validation:
    - EvalBanValidator

services:
  - name: "backend"
    path: "apps/backend"
    entryPoint: "src/index.ts"
  - name: "frontend"
    path: "apps/frontend"
    entryPoint: "src/main.tsx"
`;
      writeFileSync(join(grafemaDir, 'config.yaml'), yaml);

      const config = loadConfig(testDir);

      assert.ok(config.services, 'should have services');
      assert.strictEqual(config.services.length, 2);
      assert.deepStrictEqual(config.services[0], {
        name: 'backend',
        path: 'apps/backend',
        entryPoint: 'src/index.ts',
      });
      assert.deepStrictEqual(config.services[1], {
        name: 'frontend',
        path: 'apps/frontend',
        entryPoint: 'src/main.tsx',
      });
    });

    it('should handle services without entryPoint (optional field)', () => {
      mkdirSync(join(testDir, 'apps', 'service1'), { recursive: true });

      const yaml = `services:
  - name: "service1"
    path: "apps/service1"
`;
      writeFileSync(join(grafemaDir, 'config.yaml'), yaml);

      const config = loadConfig(testDir);

      assert.ok(config.services, 'should have services');
      assert.strictEqual(config.services.length, 1);
      assert.strictEqual(config.services[0].name, 'service1');
      assert.strictEqual(config.services[0].path, 'apps/service1');
      assert.strictEqual(config.services[0].entryPoint, undefined);
    });

    it('should default to empty services when not specified', () => {
      const yaml = `plugins:
  indexing:
    - JSModuleIndexer
`;
      writeFileSync(join(grafemaDir, 'config.yaml'), yaml);

      const config = loadConfig(testDir);

      assert.ok(Array.isArray(config.services), 'services should be an array');
      assert.strictEqual(config.services.length, 0, 'services should be empty by default');
    });

    it('should handle empty services array', () => {
      const yaml = `services: []
`;
      writeFileSync(join(grafemaDir, 'config.yaml'), yaml);

      const config = loadConfig(testDir);

      assert.ok(Array.isArray(config.services));
      assert.strictEqual(config.services.length, 0);
    });

    it('should merge services with plugins config', () => {
      mkdirSync(join(testDir, 'apps', 'api'), { recursive: true });

      const yaml = `plugins:
  indexing:
    - CustomIndexer
services:
  - name: "api"
    path: "apps/api"
`;
      writeFileSync(join(grafemaDir, 'config.yaml'), yaml);

      const config = loadConfig(testDir);

      // Plugins should be merged
      assert.deepStrictEqual(config.plugins.indexing, ['CustomIndexer']);
      // Other plugin phases should use defaults
      assert.deepStrictEqual(config.plugins.analysis, DEFAULT_CONFIG.plugins.analysis);

      // Services should be loaded
      assert.ok(config.services, 'should have services');
      assert.strictEqual(config.services.length, 1);
      assert.strictEqual(config.services[0].name, 'api');
    });

    // -------------------------------------------------------------------------
    // Validation: Fail loudly on invalid services (per Linus review)
    // -------------------------------------------------------------------------

    it('should throw error when services is not an array', () => {
      const yaml = `services: "not an array"
`;
      writeFileSync(join(grafemaDir, 'config.yaml'), yaml);

      assert.throws(
        () => loadConfig(testDir),
        /services must be an array/,
        'should throw when services is not an array'
      );
    });

    it('should throw error when service is missing name field', () => {
      mkdirSync(join(testDir, 'apps', 'myservice'), { recursive: true });

      const yaml = `services:
  - path: "apps/myservice"
`;
      writeFileSync(join(grafemaDir, 'config.yaml'), yaml);

      assert.throws(
        () => loadConfig(testDir),
        /services\[0\]\.name must be a string, got undefined/,
        'should throw when service name is missing'
      );
    });

    it('should throw error when service name is empty string', () => {
      mkdirSync(join(testDir, 'apps', 'myservice'), { recursive: true });

      const yaml = `services:
  - name: ""
    path: "apps/myservice"
`;
      writeFileSync(join(grafemaDir, 'config.yaml'), yaml);

      assert.throws(
        () => loadConfig(testDir),
        /services\[0\]\.name cannot be empty or whitespace-only/,
        'should throw when service name is empty'
      );
    });

    it('should throw error when service name is whitespace only', () => {
      mkdirSync(join(testDir, 'apps', 'myservice'), { recursive: true });

      const yaml = `services:
  - name: "   "
    path: "apps/myservice"
`;
      writeFileSync(join(grafemaDir, 'config.yaml'), yaml);

      assert.throws(
        () => loadConfig(testDir),
        /services\[0\]\.name cannot be empty or whitespace-only/,
        'should throw when service name is whitespace only'
      );
    });

    it('should throw error when service is missing path field', () => {
      const yaml = `services:
  - name: "backend"
`;
      writeFileSync(join(grafemaDir, 'config.yaml'), yaml);

      assert.throws(
        () => loadConfig(testDir),
        /services\[0\]\.path must be a string, got undefined/,
        'should throw when service path is missing'
      );
    });

    it('should throw error when service path is empty string', () => {
      const yaml = `services:
  - name: "backend"
    path: ""
`;
      writeFileSync(join(grafemaDir, 'config.yaml'), yaml);

      assert.throws(
        () => loadConfig(testDir),
        /services\[0\]\.path cannot be empty or whitespace-only/,
        'should throw when service path is empty'
      );
    });

    it('should throw error when service entry in array is not an object', () => {
      const yaml = `services:
  - "just a string"
`;
      writeFileSync(join(grafemaDir, 'config.yaml'), yaml);

      assert.throws(
        () => loadConfig(testDir),
        /services\[0\] must be an object/,
        'should throw when service entry is not an object'
      );
    });

    it('should throw error when entryPoint is not a string', () => {
      mkdirSync(join(testDir, 'apps', 'backend'), { recursive: true });

      const yaml = `services:
  - name: "backend"
    path: "apps/backend"
    entryPoint: 123
`;
      writeFileSync(join(grafemaDir, 'config.yaml'), yaml);

      assert.throws(
        () => loadConfig(testDir),
        /services\[0\]\.entryPoint must be a string, got number/,
        'should throw when entryPoint is not a string'
      );
    });

    it('should throw error when entryPoint is empty string', () => {
      mkdirSync(join(testDir, 'apps', 'backend'), { recursive: true });

      const yaml = `services:
  - name: "backend"
    path: "apps/backend"
    entryPoint: ""
`;
      writeFileSync(join(grafemaDir, 'config.yaml'), yaml);

      assert.throws(
        () => loadConfig(testDir),
        /services\[0\]\.entryPoint cannot be empty or whitespace-only/
      );
    });

    it('should throw error when entryPoint is whitespace-only', () => {
      mkdirSync(join(testDir, 'apps', 'backend'), { recursive: true });

      const yaml = `services:
  - name: "backend"
    path: "apps/backend"
    entryPoint: "   "
`;
      writeFileSync(join(grafemaDir, 'config.yaml'), yaml);

      assert.throws(
        () => loadConfig(testDir),
        /services\[0\]\.entryPoint cannot be empty or whitespace-only/
      );
    });

    it('should report correct index for validation errors', () => {
      mkdirSync(join(testDir, 'apps', 'valid'), { recursive: true });

      const yaml = `services:
  - name: "valid"
    path: "apps/valid"
  - name: "invalid"
`;
      writeFileSync(join(grafemaDir, 'config.yaml'), yaml);

      assert.throws(
        () => loadConfig(testDir),
        /services\[1\]\.path must be a string, got undefined/,
        'should report correct array index in error'
      );
    });

    // -------------------------------------------------------------------------
    // Validation: Reject absolute paths (per Linus review)
    // -------------------------------------------------------------------------

    it('should throw error when service path is absolute (Unix-style)', () => {
      const yaml = `services:
  - name: "backend"
    path: "/absolute/path/to/backend"
`;
      writeFileSync(join(grafemaDir, 'config.yaml'), yaml);

      assert.throws(
        () => loadConfig(testDir),
        /services\[0\]\.path must be relative to project root.*got "\/absolute\/path/,
        'should reject absolute Unix paths'
      );
    });

    it('should throw error when service path starts with ~/ (home directory)', () => {
      const yaml = `services:
  - name: "backend"
    path: "~/projects/backend"
`;
      writeFileSync(join(grafemaDir, 'config.yaml'), yaml);

      assert.throws(
        () => loadConfig(testDir),
        /services\[0\]\.path must be relative to project root/,
        'should reject home directory paths'
      );
    });

    // -------------------------------------------------------------------------
    // Validation: Service paths must exist (per Linus review)
    // -------------------------------------------------------------------------

    it('should throw error when service path does not exist', () => {
      const yaml = `services:
  - name: "backend"
    path: "apps/nonexistent"
`;
      writeFileSync(join(grafemaDir, 'config.yaml'), yaml);

      assert.throws(
        () => loadConfig(testDir),
        /services\[0\]\.path "apps\/nonexistent" does not exist/,
        'should throw when service path does not exist'
      );
    });

    it('should throw error when service path exists but is a file, not directory', () => {
      // Create a file (not directory) at the path
      writeFileSync(join(testDir, 'not-a-directory'), 'file content');

      const yaml = `services:
  - name: "backend"
    path: "not-a-directory"
`;
      writeFileSync(join(grafemaDir, 'config.yaml'), yaml);

      assert.throws(
        () => loadConfig(testDir),
        /services\[0\]\.path "not-a-directory" must be a directory/,
        'should throw when service path is a file'
      );
    });

    it('should validate all services paths exist', () => {
      mkdirSync(join(testDir, 'apps', 'valid'), { recursive: true });
      // Note: apps/missing does NOT exist

      const yaml = `services:
  - name: "valid"
    path: "apps/valid"
  - name: "missing"
    path: "apps/missing"
`;
      writeFileSync(join(grafemaDir, 'config.yaml'), yaml);

      assert.throws(
        () => loadConfig(testDir),
        /services\[1\]\.path "apps\/missing" does not exist/,
        'should validate path exists for each service'
      );
    });

    // -------------------------------------------------------------------------
    // Valid edge cases
    // -------------------------------------------------------------------------

    it('should accept nested relative paths', () => {
      mkdirSync(join(testDir, 'packages', 'apps', 'backend', 'src'), { recursive: true });

      const yaml = `services:
  - name: "backend"
    path: "packages/apps/backend"
`;
      writeFileSync(join(grafemaDir, 'config.yaml'), yaml);

      const config = loadConfig(testDir);

      assert.strictEqual(config.services[0].path, 'packages/apps/backend');
    });

    it('should accept relative path with ./ prefix', () => {
      mkdirSync(join(testDir, 'apps', 'backend'), { recursive: true });

      const yaml = `services:
  - name: "backend"
    path: "./apps/backend"
`;
      writeFileSync(join(grafemaDir, 'config.yaml'), yaml);

      const config = loadConfig(testDir);

      assert.strictEqual(config.services[0].path, './apps/backend');
    });

    it('should accept path at project root', () => {
      // Project root itself - represented by "."
      const yaml = `services:
  - name: "monolith"
    path: "."
`;
      writeFileSync(join(grafemaDir, 'config.yaml'), yaml);

      const config = loadConfig(testDir);

      assert.strictEqual(config.services[0].path, '.');
    });

    it('should accept service with all optional fields', () => {
      mkdirSync(join(testDir, 'apps', 'backend'), { recursive: true });

      const yaml = `services:
  - name: "backend"
    path: "apps/backend"
    entryPoint: "src/server.ts"
`;
      writeFileSync(join(grafemaDir, 'config.yaml'), yaml);

      const config = loadConfig(testDir);

      assert.deepStrictEqual(config.services[0], {
        name: 'backend',
        path: 'apps/backend',
        entryPoint: 'src/server.ts',
      });
    });

    it('should accept multiple services with mixed entryPoint presence', () => {
      mkdirSync(join(testDir, 'apps', 'api'), { recursive: true });
      mkdirSync(join(testDir, 'apps', 'web'), { recursive: true });
      mkdirSync(join(testDir, 'packages', 'shared'), { recursive: true });

      const yaml = `services:
  - name: "api"
    path: "apps/api"
    entryPoint: "src/index.ts"
  - name: "web"
    path: "apps/web"
  - name: "shared"
    path: "packages/shared"
    entryPoint: "index.ts"
`;
      writeFileSync(join(grafemaDir, 'config.yaml'), yaml);

      const config = loadConfig(testDir);

      assert.strictEqual(config.services.length, 3);
      assert.strictEqual(config.services[0].entryPoint, 'src/index.ts');
      assert.strictEqual(config.services[1].entryPoint, undefined);
      assert.strictEqual(config.services[2].entryPoint, 'index.ts');
    });
  });
});
