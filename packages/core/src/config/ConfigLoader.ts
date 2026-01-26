import { readFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { parse as parseYAML } from 'yaml';
import type { ServiceDefinition } from '@grafema/types';

/**
 * Grafema configuration schema.
 *
 * YAML Location: .grafema/config.yaml (preferred) or .grafema/config.json (deprecated)
 *
 * Example config.yaml:
 *
 * ```yaml
 * # Plugins for each analysis phase
 * plugins:
 *   indexing:
 *     - JSModuleIndexer
 *   analysis:
 *     - JSASTAnalyzer
 *     - ExpressRouteAnalyzer
 *   enrichment:
 *     - MethodCallResolver
 *   validation:
 *     - EvalBanValidator
 *
 * # Optional: Explicit service definitions (bypass auto-discovery)
 * services:
 *   - name: "backend"
 *     path: "apps/backend"        # Relative to project root
 *     entryPoint: "src/index.ts"  # Optional, auto-detected if omitted
 *   - name: "frontend"
 *     path: "apps/frontend"
 * ```
 *
 * If 'services' is not specified or empty, auto-discovery is used (SimpleProjectDiscovery).
 * If 'services' is specified and non-empty, auto-discovery plugins are skipped entirely.
 */
export interface GrafemaConfig {
  plugins: {
    discovery?: string[];
    indexing: string[];
    analysis: string[];
    enrichment: string[];
    validation: string[];
  };
  /**
   * Optional explicit services for manual configuration.
   * If provided and non-empty, auto-discovery is skipped.
   */
  services: ServiceDefinition[];
}

/**
 * Default plugin configuration.
 * Matches current DEFAULT_PLUGINS in analyze.ts and config.ts (MCP).
 */
export const DEFAULT_CONFIG: GrafemaConfig = {
  plugins: {
    discovery: [],
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
      'ArgumentParameterLinker',
      'AliasTracker',
      'ClosureCaptureEnricher',
      'ValueDomainAnalyzer',
      'MountPointResolver',
      'PrefixEvaluator',
      'ImportExportLinker',
      'HTTPConnectionEnricher',
    ],
    validation: [
      'GraphConnectivityValidator',
      'DataFlowValidator',
      'EvalBanValidator',
      'CallResolverValidator',
      'SQLInjectionValidator',
      'ShadowingDetector',
      'TypeScriptDeadCodeValidator',
      'BrokenImportValidator',
    ],
  },
  services: [], // Empty by default (uses auto-discovery)
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
    let parsed: Partial<GrafemaConfig>;

    try {
      const content = readFileSync(yamlPath, 'utf-8');
      parsed = parseYAML(content) as Partial<GrafemaConfig>;

      // Validate structure - ensure plugins sections are arrays if they exist
      if (parsed.plugins) {
        for (const phase of ['discovery', 'indexing', 'analysis', 'enrichment', 'validation'] as const) {
          const value = parsed.plugins[phase];
          if (value !== undefined && value !== null && !Array.isArray(value)) {
            throw new Error(`plugins.${phase} must be an array, got ${typeof value}`);
          }
        }
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.warn(`Failed to parse config.yaml: ${error.message}`);
      logger.warn('Using default configuration');
      return DEFAULT_CONFIG;
    }

    // Validate services array if present (THROWS on error per Linus review)
    // This is OUTSIDE try-catch - config errors MUST throw
    validateServices(parsed.services, projectPath);

    // Merge with defaults (user config may be partial)
    return mergeConfig(DEFAULT_CONFIG, parsed);
  }

  // 2. Fallback to JSON (migration path)
  if (existsSync(jsonPath)) {
    logger.warn('⚠ config.json is deprecated. Run "grafema init --force" to migrate to config.yaml');

    let parsed: Partial<GrafemaConfig>;

    try {
      const content = readFileSync(jsonPath, 'utf-8');
      parsed = JSON.parse(content) as Partial<GrafemaConfig>;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.warn(`Failed to parse config.json: ${error.message}`);
      logger.warn('Using default configuration');
      return DEFAULT_CONFIG;
    }

    // Validate services array if present (THROWS on error)
    // This is OUTSIDE try-catch - config errors MUST throw
    validateServices(parsed.services, projectPath);

    return mergeConfig(DEFAULT_CONFIG, parsed);
  }

  // 3. No config file - return defaults
  return DEFAULT_CONFIG;
}

/**
 * Validate services array structure.
 * THROWS on error (fail loudly per Linus review).
 *
 * @param services - Parsed services array (may be undefined)
 * @param projectPath - Project root for path validation
 */
function validateServices(services: unknown, projectPath: string): void {
  // undefined/null is valid (means use defaults)
  if (services === undefined || services === null) {
    return;
  }

  // Must be an array
  if (!Array.isArray(services)) {
    throw new Error(`Config error: services must be an array, got ${typeof services}`);
  }

  // Validate each service
  for (let i = 0; i < services.length; i++) {
    const svc = services[i];

    // Must be an object
    if (typeof svc !== 'object' || svc === null) {
      throw new Error(`Config error: services[${i}] must be an object`);
    }

    // Name validation - required, non-empty string
    if (typeof svc.name !== 'string') {
      throw new Error(`Config error: services[${i}].name must be a string, got ${typeof svc.name}`);
    }
    if (!svc.name.trim()) {
      throw new Error(`Config error: services[${i}].name cannot be empty or whitespace-only`);
    }

    // Path validation - required, non-empty string
    if (typeof svc.path !== 'string') {
      throw new Error(`Config error: services[${i}].path must be a string, got ${typeof svc.path}`);
    }
    if (!svc.path.trim()) {
      throw new Error(`Config error: services[${i}].path cannot be empty or whitespace-only`);
    }

    // Path validation - must be relative (reject absolute paths per Linus review)
    if (svc.path.startsWith('/') || svc.path.startsWith('~')) {
      throw new Error(`Config error: services[${i}].path must be relative to project root, got "${svc.path}"`);
    }

    // Path validation - must exist
    const absolutePath = join(projectPath, svc.path);
    if (!existsSync(absolutePath)) {
      throw new Error(`Config error: services[${i}].path "${svc.path}" does not exist`);
    }

    // Path validation - must be directory
    if (!statSync(absolutePath).isDirectory()) {
      throw new Error(`Config error: services[${i}].path "${svc.path}" must be a directory`);
    }

    // entryPoint validation (optional field) - must be non-empty string if provided
    if (svc.entryPoint !== undefined) {
      if (typeof svc.entryPoint !== 'string') {
        throw new Error(`Config error: services[${i}].entryPoint must be a string, got ${typeof svc.entryPoint}`);
      }
      if (!svc.entryPoint.trim()) {
        throw new Error(`Config error: services[${i}].entryPoint cannot be empty or whitespace-only`);
      }
    }
  }
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
      discovery: user.plugins?.discovery ?? defaults.plugins.discovery,
      indexing: user.plugins?.indexing ?? defaults.plugins.indexing,
      analysis: user.plugins?.analysis ?? defaults.plugins.analysis,
      enrichment: user.plugins?.enrichment ?? defaults.plugins.enrichment,
      validation: user.plugins?.validation ?? defaults.plugins.validation,
    },
    services: user.services ?? defaults.services,
  };
}
