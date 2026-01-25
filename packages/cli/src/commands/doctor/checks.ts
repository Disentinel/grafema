/**
 * Diagnostic check functions for `grafema doctor` command - REG-214
 *
 * Checks are organized in levels:
 * - Level 1: Prerequisites (fail-fast) - checkGrafemaInitialized, checkServerStatus
 * - Level 2: Configuration - checkConfigValidity, checkEntrypoints
 * - Level 3: Graph Health - checkDatabaseExists, checkGraphStats, checkConnectivity, checkFreshness
 * - Level 4: Informational - checkVersions
 */

import { existsSync, readFileSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import {
  RFDBServerBackend,
  RFDBClient,
  loadConfig,
  GraphFreshnessChecker,
} from '@grafema/core';
import type { DoctorCheckResult } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Valid built-in plugin names (for config validation)
const VALID_PLUGIN_NAMES = new Set([
  // Discovery
  'SimpleProjectDiscovery', 'MonorepoServiceDiscovery', 'WorkspaceDiscovery',
  // Indexing
  'JSModuleIndexer', 'RustModuleIndexer',
  // Analysis
  'JSASTAnalyzer', 'ExpressRouteAnalyzer', 'SocketIOAnalyzer', 'DatabaseAnalyzer',
  'FetchAnalyzer', 'ServiceLayerAnalyzer', 'ReactAnalyzer', 'RustAnalyzer',
  // Enrichment
  'MethodCallResolver', 'AliasTracker', 'ValueDomainAnalyzer', 'MountPointResolver',
  'PrefixEvaluator', 'InstanceOfResolver', 'ImportExportLinker', 'HTTPConnectionEnricher',
  'RustFFIEnricher',
  // Validation
  'CallResolverValidator', 'EvalBanValidator', 'SQLInjectionValidator', 'ShadowingDetector',
  'GraphConnectivityValidator', 'DataFlowValidator', 'TypeScriptDeadCodeValidator',
]);

// =============================================================================
// Level 1: Prerequisites (fail-fast)
// =============================================================================

/**
 * Check if .grafema directory exists with config file.
 * FAIL if not initialized.
 */
export async function checkGrafemaInitialized(
  projectPath: string
): Promise<DoctorCheckResult> {
  const grafemaDir = join(projectPath, '.grafema');
  const configYaml = join(grafemaDir, 'config.yaml');
  const configJson = join(grafemaDir, 'config.json');

  if (!existsSync(grafemaDir)) {
    return {
      name: 'initialization',
      status: 'fail',
      message: '.grafema directory not found',
      recommendation: 'Run: grafema init',
    };
  }

  if (!existsSync(configYaml) && !existsSync(configJson)) {
    return {
      name: 'initialization',
      status: 'fail',
      message: 'Config file not found',
      recommendation: 'Run: grafema init',
    };
  }

  const configFile = existsSync(configYaml) ? 'config.yaml' : 'config.json';
  const deprecated = configFile === 'config.json';

  return {
    name: 'initialization',
    status: deprecated ? 'warn' : 'pass',
    message: `Config file: .grafema/${configFile}`,
    recommendation: deprecated ? 'Run: grafema init --force (migrate to YAML)' : undefined,
  };
}

/**
 * Check if RFDB server is running and responsive.
 * WARN if not running (server starts on-demand during analyze).
 */
export async function checkServerStatus(
  projectPath: string
): Promise<DoctorCheckResult> {
  const socketPath = join(projectPath, '.grafema', 'rfdb.sock');

  if (!existsSync(socketPath)) {
    return {
      name: 'server',
      status: 'warn',
      message: 'RFDB server not running',
      recommendation: 'Run: grafema analyze (starts server automatically)',
    };
  }

  const client = new RFDBClient(socketPath);
  client.on('error', () => {}); // Suppress error events

  try {
    await client.connect();
    const version = await client.ping();
    await client.close();

    return {
      name: 'server',
      status: 'pass',
      message: `Server: connected (RFDB ${version || 'unknown'})`,
      details: { version, socketPath },
    };
  } catch {
    return {
      name: 'server',
      status: 'warn',
      message: 'Server socket exists but not responding (stale)',
      recommendation: 'Run: grafema analyze (will restart server)',
    };
  }
}

// =============================================================================
// Level 2: Configuration Validity
// =============================================================================

/**
 * Validate config file syntax and structure.
 * Uses existing loadConfig() which throws on errors.
 */
export async function checkConfigValidity(
  projectPath: string
): Promise<DoctorCheckResult> {
  try {
    // Silent logger to suppress warnings during validation
    const config = loadConfig(projectPath, { warn: () => {} });

    // Check for unknown plugins
    const unknownPlugins: string[] = [];
    const phases = ['discovery', 'indexing', 'analysis', 'enrichment', 'validation'] as const;

    for (const phase of phases) {
      const plugins = config.plugins[phase] || [];
      for (const name of plugins) {
        if (!VALID_PLUGIN_NAMES.has(name)) {
          unknownPlugins.push(name);
        }
      }
    }

    if (unknownPlugins.length > 0) {
      return {
        name: 'config',
        status: 'warn',
        message: `Unknown plugin(s): ${unknownPlugins.join(', ')}`,
        recommendation: 'Check plugin names for typos. Run: grafema doctor --verbose for available plugins',
        details: { unknownPlugins },
      };
    }

    const totalPlugins = phases.reduce(
      (sum, phase) => sum + (config.plugins[phase]?.length || 0), 0
    );

    return {
      name: 'config',
      status: 'pass',
      message: `Config valid: ${totalPlugins} plugins configured`,
      details: { pluginCount: totalPlugins, services: config.services.length },
    };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    return {
      name: 'config',
      status: 'fail',
      message: `Config error: ${error.message}`,
      recommendation: 'Fix config.yaml syntax or run: grafema init --force',
    };
  }
}

/**
 * Check that entrypoints can be resolved.
 * For config-defined services, validates that entrypoint files exist.
 */
export async function checkEntrypoints(
  projectPath: string
): Promise<DoctorCheckResult> {
  let config;
  try {
    config = loadConfig(projectPath, { warn: () => {} });
  } catch {
    // Config loading failed - already reported by checkConfigValidity
    return {
      name: 'entrypoints',
      status: 'skip',
      message: 'Skipped (config error)',
    };
  }

  if (config.services.length === 0) {
    // Auto-discovery mode - check package.json exists
    const pkgJson = join(projectPath, 'package.json');
    if (!existsSync(pkgJson)) {
      return {
        name: 'entrypoints',
        status: 'warn',
        message: 'No package.json found for auto-discovery',
        recommendation: 'Add package.json or configure services in config.yaml',
      };
    }
    return {
      name: 'entrypoints',
      status: 'pass',
      message: 'Using auto-discovery mode',
    };
  }

  // Config-defined services - validate each
  const issues: string[] = [];
  const valid: string[] = [];

  for (const svc of config.services) {
    const svcPath = join(projectPath, svc.path);
    let entrypoint: string;

    if (svc.entryPoint) {
      entrypoint = join(svcPath, svc.entryPoint);
    } else {
      // Auto-detect from package.json
      const pkgPath = join(svcPath, 'package.json');
      if (existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
          entrypoint = join(svcPath, pkg.main || 'index.js');
        } catch {
          entrypoint = join(svcPath, 'index.js');
        }
      } else {
        entrypoint = join(svcPath, 'index.js');
      }
    }

    if (existsSync(entrypoint)) {
      valid.push(svc.name);
    } else {
      issues.push(`${svc.name}: ${entrypoint} not found`);
    }
  }

  if (issues.length > 0) {
    return {
      name: 'entrypoints',
      status: 'warn',
      message: `${issues.length} service(s) with missing entrypoints`,
      recommendation: 'Check service paths in config.yaml',
      details: { issues, valid },
    };
  }

  return {
    name: 'entrypoints',
    status: 'pass',
    message: `Entrypoints: ${valid.length} service(s) found`,
    details: { services: valid },
  };
}

// =============================================================================
// Level 3: Graph Health
// =============================================================================

/**
 * Check if database file exists and has data.
 */
export async function checkDatabaseExists(
  projectPath: string
): Promise<DoctorCheckResult> {
  const dbPath = join(projectPath, '.grafema', 'graph.rfdb');

  if (!existsSync(dbPath)) {
    return {
      name: 'database',
      status: 'fail',
      message: 'Database not found',
      recommendation: 'Run: grafema analyze',
    };
  }

  // Check file size (empty DB is typically < 100 bytes)
  const stats = statSync(dbPath);
  if (stats.size < 100) {
    return {
      name: 'database',
      status: 'warn',
      message: 'Database appears empty',
      recommendation: 'Run: grafema analyze',
    };
  }

  return {
    name: 'database',
    status: 'pass',
    message: `Database: ${dbPath}`,
    details: { size: stats.size },
  };
}

/**
 * Get graph statistics (requires server running).
 */
export async function checkGraphStats(
  projectPath: string
): Promise<DoctorCheckResult> {
  const socketPath = join(projectPath, '.grafema', 'rfdb.sock');
  const dbPath = join(projectPath, '.grafema', 'graph.rfdb');

  if (!existsSync(socketPath)) {
    return {
      name: 'graph_stats',
      status: 'skip',
      message: 'Server not running (skipped stats check)',
    };
  }

  const backend = new RFDBServerBackend({ dbPath });
  try {
    await backend.connect();
    const stats = await backend.getStats();
    await backend.close();

    if (stats.nodeCount === 0) {
      return {
        name: 'graph_stats',
        status: 'fail',
        message: 'Database is empty (0 nodes)',
        recommendation: 'Run: grafema analyze',
      };
    }

    return {
      name: 'graph_stats',
      status: 'pass',
      message: `Graph: ${stats.nodeCount.toLocaleString()} nodes, ${stats.edgeCount.toLocaleString()} edges`,
      details: {
        nodeCount: stats.nodeCount,
        edgeCount: stats.edgeCount,
        nodesByType: stats.nodesByType,
        edgesByType: stats.edgesByType,
      },
    };
  } catch (err) {
    return {
      name: 'graph_stats',
      status: 'warn',
      message: `Could not read graph stats: ${(err as Error).message}`,
    };
  }
}

/**
 * Check graph connectivity - find disconnected nodes.
 * Thresholds:
 *   0-5%: pass (normal for external modules)
 *   5-20%: warn
 *   >20%: fail (critical issue)
 */
export async function checkConnectivity(
  projectPath: string
): Promise<DoctorCheckResult> {
  const socketPath = join(projectPath, '.grafema', 'rfdb.sock');
  const dbPath = join(projectPath, '.grafema', 'graph.rfdb');

  if (!existsSync(socketPath)) {
    return {
      name: 'connectivity',
      status: 'skip',
      message: 'Server not running (skipped connectivity check)',
    };
  }

  const backend = new RFDBServerBackend({ dbPath });
  try {
    await backend.connect();

    // Get all nodes
    const allNodes: Array<{ id: string; type: string }> = [];
    for await (const node of backend.queryNodes({})) {
      allNodes.push({ id: node.id, type: node.type as string });
    }
    const totalCount = allNodes.length;

    if (totalCount === 0) {
      await backend.close();
      return {
        name: 'connectivity',
        status: 'skip',
        message: 'No nodes to check',
      };
    }

    // Find root nodes (SERVICE, MODULE, PROJECT)
    const rootTypes = ['SERVICE', 'MODULE', 'PROJECT'];
    const rootNodes = allNodes.filter(n => rootTypes.includes(n.type));

    if (rootNodes.length === 0) {
      await backend.close();
      return {
        name: 'connectivity',
        status: 'warn',
        message: 'No root nodes found (SERVICE/MODULE/PROJECT)',
        recommendation: 'Run: grafema analyze',
      };
    }

    // Get all edges and build adjacency
    const allEdges = await backend.getAllEdges();

    const adjacencyOut = new Map<string, string[]>();
    const adjacencyIn = new Map<string, string[]>();

    for (const edge of allEdges) {
      if (!adjacencyOut.has(edge.src)) adjacencyOut.set(edge.src, []);
      adjacencyOut.get(edge.src)!.push(edge.dst);
      if (!adjacencyIn.has(edge.dst)) adjacencyIn.set(edge.dst, []);
      adjacencyIn.get(edge.dst)!.push(edge.src);
    }

    // BFS from roots
    const reachable = new Set<string>();
    const queue = [...rootNodes.map(n => n.id)];

    while (queue.length > 0) {
      const nodeId = queue.shift()!;
      if (reachable.has(nodeId)) continue;
      reachable.add(nodeId);
      const outgoing = adjacencyOut.get(nodeId) || [];
      const incoming = adjacencyIn.get(nodeId) || [];
      for (const targetId of [...outgoing, ...incoming]) {
        if (!reachable.has(targetId)) queue.push(targetId);
      }
    }

    await backend.close();

    const unreachableCount = totalCount - reachable.size;
    const percentage = (unreachableCount / totalCount) * 100;

    if (unreachableCount === 0) {
      return {
        name: 'connectivity',
        status: 'pass',
        message: 'All nodes connected',
        details: { totalNodes: totalCount },
      };
    }

    // Group unreachable by type
    const unreachableNodes = allNodes.filter(n => !reachable.has(n.id));
    const byType: Record<string, number> = {};
    for (const node of unreachableNodes) {
      byType[node.type] = (byType[node.type] || 0) + 1;
    }

    if (percentage > 20) {
      return {
        name: 'connectivity',
        status: 'fail',
        message: `Critical: ${unreachableCount} disconnected nodes (${percentage.toFixed(1)}%)`,
        recommendation: 'Run: grafema analyze --clear (rebuild graph)',
        details: { unreachableCount, percentage, byType },
      };
    }

    if (percentage > 5) {
      return {
        name: 'connectivity',
        status: 'warn',
        message: `${unreachableCount} disconnected nodes (${percentage.toFixed(1)}%)`,
        recommendation: 'Run: grafema analyze --clear (may fix)',
        details: { unreachableCount, percentage, byType },
      };
    }

    return {
      name: 'connectivity',
      status: 'pass',
      message: `${unreachableCount} disconnected nodes (${percentage.toFixed(1)}% - normal)`,
      details: { unreachableCount, percentage, byType },
    };
  } catch (err) {
    return {
      name: 'connectivity',
      status: 'warn',
      message: `Could not check connectivity: ${(err as Error).message}`,
    };
  }
}

/**
 * Check if graph is fresh (no stale modules).
 */
export async function checkFreshness(
  projectPath: string
): Promise<DoctorCheckResult> {
  const socketPath = join(projectPath, '.grafema', 'rfdb.sock');
  const dbPath = join(projectPath, '.grafema', 'graph.rfdb');

  if (!existsSync(socketPath)) {
    return {
      name: 'freshness',
      status: 'skip',
      message: 'Server not running (skipped freshness check)',
    };
  }

  const backend = new RFDBServerBackend({ dbPath });
  try {
    await backend.connect();
    const freshnessChecker = new GraphFreshnessChecker();
    const result = await freshnessChecker.checkFreshness(backend);
    await backend.close();

    if (result.isFresh) {
      return {
        name: 'freshness',
        status: 'pass',
        message: 'Graph is up to date',
      };
    }

    return {
      name: 'freshness',
      status: 'warn',
      message: `${result.staleCount} stale module(s) detected`,
      recommendation: 'Run: grafema analyze (or grafema check for auto-reanalysis)',
      details: {
        staleCount: result.staleCount,
        staleModules: result.staleModules.slice(0, 5).map(m => m.file),
      },
    };
  } catch (err) {
    return {
      name: 'freshness',
      status: 'warn',
      message: `Could not check freshness: ${(err as Error).message}`,
    };
  }
}

// =============================================================================
// Level 4: Informational
// =============================================================================

/**
 * Collect version information (always passes).
 */
export async function checkVersions(
  projectPath: string
): Promise<DoctorCheckResult> {
  let cliVersion = 'unknown';
  let coreVersion = 'unknown';
  let rfdbVersion: string | undefined;

  // Read CLI version - from dist/commands/doctor/ go up 3 levels to cli/
  try {
    const cliPkgPath = join(__dirname, '../../../package.json');
    const cliPkg = JSON.parse(readFileSync(cliPkgPath, 'utf-8'));
    cliVersion = cliPkg.version;
  } catch {
    // Ignore errors
  }

  // Read core version
  try {
    const require = createRequire(import.meta.url);
    const corePkgPath = require.resolve('@grafema/core/package.json');
    const corePkg = JSON.parse(readFileSync(corePkgPath, 'utf-8'));
    coreVersion = corePkg.version;
  } catch {
    // Ignore errors
  }

  // Get RFDB version from server if running
  const socketPath = join(projectPath, '.grafema', 'rfdb.sock');
  if (existsSync(socketPath)) {
    const client = new RFDBClient(socketPath);
    client.on('error', () => {});
    try {
      await client.connect();
      const version = await client.ping();
      rfdbVersion = version || undefined;
      await client.close();
    } catch {
      // Ignore errors
    }
  }

  return {
    name: 'versions',
    status: 'pass',
    message: `CLI ${cliVersion}, Core ${coreVersion}${rfdbVersion ? `, RFDB ${rfdbVersion}` : ''}`,
    details: { cli: cliVersion, core: coreVersion, rfdb: rfdbVersion },
  };
}
