import { readFileSync, existsSync, statSync } from 'fs';
import { join, basename } from 'path';
import { parse as parseYAML } from 'yaml';
import type { ServiceDefinition } from '@grafema/types';
import { GRAFEMA_VERSION, getSchemaVersion } from '../version.js';

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
  /**
   * Config schema version (major.minor.patch, no pre-release tag).
   * Must be compatible with the running Grafema version.
   * If omitted, no version check is performed (backward compatibility).
   *
   * @example "0.2.5"
   */
  version?: string;

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

  /**
   * Enable strict mode for fail-fast debugging.
   * When true, analysis fails if enrichers cannot resolve references.
   * When false (default), graceful degradation with warnings.
   *
   * Can be overridden via CLI: --strict
   */
  strict?: boolean;

  /**
   * Multi-root workspace configuration (REG-76).
   * Allows indexing multiple directories as a single unified graph.
   * Each root is prefixed in semantic IDs to prevent collisions.
   *
   * @example
   * ```yaml
   * workspace:
   *   roots:
   *     - ./backend
   *     - ./frontend
   *     - ./shared
   * ```
   */
  workspace?: WorkspaceConfig;
}

/**
 * Multi-root workspace configuration.
 * Each root directory is indexed separately but produces a unified graph.
 * Root names (basename of path) are prefixed to file paths in semantic IDs.
 */
export interface WorkspaceConfig {
  /**
   * List of root directories to include in the workspace.
   * Paths are relative to the project root (where .grafema/ is located).
   * Each root's basename is used as prefix in semantic IDs.
   */
  roots: string[];
}

/**
 * Default plugin configuration.
 * Matches current DEFAULT_PLUGINS in analyze.ts and config.ts (MCP).
 */
export const DEFAULT_CONFIG: GrafemaConfig = {
  version: getSchemaVersion(GRAFEMA_VERSION),
  plugins: {
    discovery: [],
    indexing: ['JSModuleIndexer'],
    analysis: [
      'JSASTAnalyzer',
      'ExpressRouteAnalyzer',
      'ExpressResponseAnalyzer',
      'NestJSRouteAnalyzer',
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
      'RejectionPropagationEnricher',
      'ValueDomainAnalyzer',
      'MountPointResolver',
      'ExpressHandlerLinker',
      'PrefixEvaluator',
      'ImportExportLinker',
      'HTTPConnectionEnricher',
      'CallbackCallResolver',
    ],
    validation: [
      'GraphConnectivityValidator',
      'DataFlowValidator',
      'EvalBanValidator',
      'CallResolverValidator',
      'SQLInjectionValidator',
      'AwaitInLoopValidator',
      'ShadowingDetector',
      'TypeScriptDeadCodeValidator',
      'BrokenImportValidator',
    ],
  },
  services: [], // Empty by default (uses auto-discovery)
  strict: false, // Graceful degradation by default
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

    // Validate version compatibility (THROWS on error) - REG-403
    validateVersion(parsed.version);

    // Validate services array if present (THROWS on error per Linus review)
    // This is OUTSIDE try-catch - config errors MUST throw
    validateServices(parsed.services, projectPath);

    // Validate include/exclude patterns (THROWS on error)
    validatePatterns(parsed.include, parsed.exclude, logger);

    // Validate workspace.roots if present (THROWS on error) - REG-76
    validateWorkspace(parsed.workspace, projectPath);

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

    // Validate version compatibility (THROWS on error) - REG-403
    validateVersion(parsed.version);

    // Validate services array if present (THROWS on error)
    // This is OUTSIDE try-catch - config errors MUST throw
    validateServices(parsed.services, projectPath);

    // Validate include/exclude patterns (THROWS on error)
    validatePatterns(parsed.include, parsed.exclude, logger);

    // Validate workspace.roots if present (THROWS on error) - REG-76
    validateWorkspace(parsed.workspace, projectPath);

    return mergeConfig(DEFAULT_CONFIG, parsed);
  }

  // 3. No config file - return defaults
  return DEFAULT_CONFIG;
}

/**
 * Validate config version compatibility with running Grafema version.
 * THROWS on error (fail loudly per project convention).
 *
 * Compares major.minor.patch (pre-release tags are stripped).
 * If config has no version field, validation passes silently (backward compat).
 *
 * @param configVersion - Version string from config file (may be undefined)
 * @param currentVersion - Override for testing (defaults to GRAFEMA_VERSION)
 */
export function validateVersion(
  configVersion: unknown,
  currentVersion?: string
): void {
  // No version field = backward compat, accept silently
  if (configVersion === undefined || configVersion === null) {
    return;
  }

  if (typeof configVersion !== 'string') {
    throw new Error(`Config error: version must be a string, got ${typeof configVersion}`);
  }

  if (!configVersion.trim()) {
    throw new Error('Config error: version cannot be empty');
  }

  const current = currentVersion ?? GRAFEMA_VERSION;
  const configSchema = getSchemaVersion(configVersion);
  const currentSchema = getSchemaVersion(current);

  if (configSchema !== currentSchema) {
    throw new Error(
      `Config error: config version "${configVersion}" is not compatible with ` +
      `Grafema ${current}. Expected "${currentSchema}".\n` +
      `  Run: grafema init --force  (to regenerate config for current version)`
    );
  }
}

/**
 * Validate services array structure.
 * THROWS on error (fail loudly per Linus review).
 *
 * @param services - Parsed services array (may be undefined)
 * @param projectPath - Project root for path validation
 */
export function validateServices(services: unknown, projectPath: string): void {
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
 * Validate workspace configuration (REG-76).
 * THROWS on error (fail loudly per project convention).
 *
 * Validation rules:
 * 1. workspace.roots must be an array if provided
 * 2. Each root must be a non-empty string
 * 3. Each root path must exist and be a directory
 * 4. Root basenames must be unique (to prevent semantic ID collisions)
 *
 * @param workspace - Parsed workspace config (may be undefined)
 * @param projectPath - Project root for path validation
 */
export function validateWorkspace(workspace: unknown, projectPath: string): void {
  // undefined/null is valid (means single-root mode)
  if (workspace === undefined || workspace === null) {
    return;
  }

  // Must be an object
  if (typeof workspace !== 'object') {
    throw new Error(`Config error: workspace must be an object, got ${typeof workspace}`);
  }

  const ws = workspace as { roots?: unknown };

  // roots is optional, but if provided must be valid
  if (ws.roots === undefined || ws.roots === null) {
    return;
  }

  // roots must be an array
  if (!Array.isArray(ws.roots)) {
    throw new Error(`Config error: workspace.roots must be an array, got ${typeof ws.roots}`);
  }

  // Track root names for duplicate detection
  const seenNames = new Set<string>();

  // Validate each root
  for (let i = 0; i < ws.roots.length; i++) {
    const root = ws.roots[i];

    // Must be a string
    if (typeof root !== 'string') {
      throw new Error(`Config error: workspace.roots[${i}] must be a string, got ${typeof root}`);
    }

    // Must not be empty
    if (!root.trim()) {
      throw new Error(`Config error: workspace.roots[${i}] cannot be empty or whitespace-only`);
    }

    // Must be relative path
    if (root.startsWith('/') || root.startsWith('~')) {
      throw new Error(`Config error: workspace.roots[${i}] must be relative to project root, got "${root}"`);
    }

    // Path must exist
    const absolutePath = join(projectPath, root);
    if (!existsSync(absolutePath)) {
      throw new Error(`Config error: workspace.roots[${i}] "${root}" does not exist`);
    }

    // Path must be a directory
    if (!statSync(absolutePath).isDirectory()) {
      throw new Error(`Config error: workspace.roots[${i}] "${root}" must be a directory`);
    }

    // Check for duplicate root names (basename)
    const rootName = basename(root);
    if (seenNames.has(rootName)) {
      throw new Error(`Config error: Duplicate workspace root name "${rootName}" - root names (basenames) must be unique`);
    }
    seenNames.add(rootName);
  }
}

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
export function validatePatterns(
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

/**
 * Merge user config with defaults.
 * User config takes precedence, but missing sections use defaults.
 */
function mergeConfig(
  defaults: GrafemaConfig,
  user: Partial<GrafemaConfig>
): GrafemaConfig {
  return {
    version: user.version ?? defaults.version,
    plugins: {
      discovery: user.plugins?.discovery ?? defaults.plugins.discovery,
      indexing: user.plugins?.indexing ?? defaults.plugins.indexing,
      analysis: user.plugins?.analysis ?? defaults.plugins.analysis,
      enrichment: user.plugins?.enrichment ?? defaults.plugins.enrichment,
      validation: user.plugins?.validation ?? defaults.plugins.validation,
    },
    services: user.services ?? defaults.services,
    // Include/exclude patterns: pass through if specified, otherwise undefined
    // (don't merge with defaults - undefined means "no filtering")
    // Note: YAML null becomes undefined here (null ?? undefined = undefined)
    include: user.include ?? undefined,
    exclude: user.exclude ?? undefined,
    strict: user.strict ?? defaults.strict,
    // Workspace config: pass through if specified (REG-76)
    workspace: user.workspace ?? undefined,
  };
}
