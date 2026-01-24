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
    discovery?: string[];
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

      // Validate structure - ensure plugins sections are arrays if they exist
      if (parsed.plugins) {
        for (const phase of ['indexing', 'analysis', 'enrichment', 'validation'] as const) {
          const value = parsed.plugins[phase];
          if (value !== undefined && value !== null && !Array.isArray(value)) {
            throw new Error(`plugins.${phase} must be an array, got ${typeof value}`);
          }
        }
      }

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
      discovery: user.plugins?.discovery ?? defaults.plugins.discovery,
    },
  };
}
