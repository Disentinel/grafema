# Joel Spolsky - Technical Plan for `grafema doctor`

## Executive Summary

This document expands Don's high-level plan into a detailed implementation spec. I've researched the codebase to answer all open questions and provide exact code snippets, function signatures, and test scenarios.

## Answers to Don's Open Questions

### 1. Freshness Check
**Question:** Do we track last analysis timestamp?

**Answer:** YES. `GraphFreshnessChecker` exists and is already used by `check.ts`. It compares file hashes stored in MODULE nodes against current file system state.

```typescript
// From packages/core/src/core/GraphFreshnessChecker.ts
export interface FreshnessResult {
  isFresh: boolean;
  staleCount: number;
  staleModules: StaleModule[];
}

export interface StaleModule {
  file: string;
  moduleId: string;
  reason: 'modified' | 'deleted' | 'new';
}
```

We can reuse `GraphFreshnessChecker.checkFreshness(backend)` directly.

### 2. Manifest/Validation Access
**Question:** Can we read validation results from manifest without full graph traversal?

**Answer:** PARTIALLY. `GraphConnectivityValidator` stores results in the manifest object during analysis, but the manifest is NOT persisted to disk. Each analysis run creates a fresh manifest in memory.

**Recommendation:** For doctor, we should compute connectivity on-demand (lightweight BFS from root nodes). The code exists in `GraphConnectivityValidator` and can be extracted into a reusable function.

### 3. Plugin Validation
**Question:** Should we verify plugin classes exist, or just warn on unknown names?

**Answer:** WARN ONLY. Plugin names are validated by `BUILTIN_PLUGINS` map in `analyze.ts`:

```typescript
// packages/cli/src/commands/analyze.ts lines 54-88
const BUILTIN_PLUGINS: Record<string, () => Plugin> = {
  SimpleProjectDiscovery, JSModuleIndexer, JSASTAnalyzer,
  // ... 26 total plugins
};
```

Doctor should check if all plugin names in config are in this map. Unknown = warning.

### 4. Service Entrypoints
**Question:** Should we validate entrypoint files exist on disk?

**Answer:** YES. `ConfigLoader.validateServices()` already does path validation (lines 223-230), but only for directories. Doctor should additionally check that resolved entrypoint files exist.

### 5. Server Health
**Question:** How to check server status?

**Answer:** Use `isServerRunning()` pattern from `server.ts`:

```typescript
// packages/cli/src/commands/server.ts lines 73-91
async function isServerRunning(socketPath: string): Promise<{ running: boolean; version?: string }> {
  if (!existsSync(socketPath)) return { running: false };
  const client = new RFDBClient(socketPath);
  client.on('error', () => {});
  try {
    await client.connect();
    const version = await client.ping();
    await client.close();
    return { running: true, version: version || undefined };
  } catch {
    return { running: false };
  }
}
```

### 6. Stats API
**Question:** What does `getStats()` return?

**Answer:**
```typescript
// packages/core/src/storage/backends/RFDBServerBackend.ts lines 629-642
async getStats(): Promise<BackendStats> {
  const nodeCount = await this.client.nodeCount();
  const edgeCount = await this.client.edgeCount();
  const nodeCounts = await this.client.countNodesByType();
  const edgeCounts = await this.client.countEdgesByType();
  return { nodeCount, edgeCount, nodesByType: nodeCounts, edgesByType: edgeCounts };
}
```

---

## File Structure

### New Files

```
packages/cli/src/commands/doctor.ts          # Main command implementation
packages/cli/src/commands/doctor/checks.ts   # Individual check functions
packages/cli/src/commands/doctor/types.ts    # TypeScript interfaces
packages/cli/src/commands/doctor/output.ts   # Output formatting utilities
```

### Modified Files

```
packages/cli/src/cli.ts                      # Register doctor command
```

---

## Interface Definitions

### types.ts

```typescript
/**
 * Status of a single diagnostic check
 */
export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip';

/**
 * Result of a single diagnostic check
 */
export interface DoctorCheckResult {
  name: string;           // e.g., 'config', 'server', 'database'
  status: CheckStatus;
  message: string;        // Human-readable message
  recommendation?: string; // Actionable next step if not pass
  details?: Record<string, unknown>; // Additional data (counts, versions, etc.)
}

/**
 * Options for the doctor command
 */
export interface DoctorOptions {
  project: string;        // Project path (default: ".")
  json?: boolean;         // Output as JSON
  quiet?: boolean;        // Only show failures
  verbose?: boolean;      // Show detailed diagnostics
}

/**
 * Overall doctor report (for JSON output)
 */
export interface DoctorReport {
  status: 'healthy' | 'warning' | 'error';
  timestamp: string;      // ISO timestamp
  project: string;        // Absolute project path
  checks: DoctorCheckResult[];
  recommendations: string[];
  versions: {
    cli: string;
    core: string;
    rfdb?: string;
  };
}
```

---

## Check Implementations

### Level 1: Prerequisites (fail-fast)

#### Check 1: `checkGrafemaInitialized`

```typescript
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
```

#### Check 2: `checkServerStatus`

```typescript
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
```

### Level 2: Configuration Validity

#### Check 3: `checkConfigValidity`

```typescript
/**
 * Validate config file syntax and structure.
 * Uses existing loadConfig() which throws on errors.
 */
export async function checkConfigValidity(
  projectPath: string
): Promise<DoctorCheckResult> {
  try {
    const config = loadConfig(projectPath, { warn: () => {} }); // Silent logger

    // Check for unknown plugins
    const unknownPlugins: string[] = [];
    const phases = ['discovery', 'indexing', 'analysis', 'enrichment', 'validation'] as const;

    for (const phase of phases) {
      const plugins = config.plugins[phase] || [];
      for (const name of plugins) {
        if (!BUILTIN_PLUGINS[name]) {
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
```

#### Check 4: `checkEntrypoints`

```typescript
/**
 * Check that entrypoints can be resolved.
 * For config-defined services, validates that entrypoint files exist.
 */
export async function checkEntrypoints(
  projectPath: string
): Promise<DoctorCheckResult> {
  const config = loadConfig(projectPath, { warn: () => {} });

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
          const resolved = resolveSourceEntrypoint(svcPath, pkg);
          entrypoint = resolved ? join(svcPath, resolved) : join(svcPath, pkg.main || 'index.js');
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
    message: `Entrypoints: ${valid.length} found`,
    details: { services: valid },
  };
}
```

### Level 3: Graph Health

#### Check 5: `checkDatabaseExists`

```typescript
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
```

#### Check 6: `checkGraphStats`

```typescript
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
```

#### Check 7: `checkConnectivity`

```typescript
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
    const allNodes = await backend.getAllNodes();
    const totalCount = allNodes.length;

    if (totalCount === 0) {
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
```

#### Check 8: `checkFreshness`

```typescript
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
```

### Level 4: Informational

#### Check 9: `checkVersions`

```typescript
/**
 * Collect version information (always passes).
 */
export async function checkVersions(
  projectPath: string
): Promise<DoctorCheckResult> {
  // Read CLI version from package.json
  const cliPkgPath = join(__dirname, '../../../package.json');
  const corePkgPath = require.resolve('@grafema/core/package.json');

  let cliVersion = 'unknown';
  let coreVersion = 'unknown';
  let rfdbVersion: string | undefined;

  try {
    const cliPkg = JSON.parse(readFileSync(cliPkgPath, 'utf-8'));
    cliVersion = cliPkg.version;
  } catch {}

  try {
    const corePkg = JSON.parse(readFileSync(corePkgPath, 'utf-8'));
    coreVersion = corePkg.version;
  } catch {}

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
    } catch {}
  }

  return {
    name: 'versions',
    status: 'pass',
    message: `CLI ${cliVersion}, Core ${coreVersion}${rfdbVersion ? `, RFDB ${rfdbVersion}` : ''}`,
    details: { cli: cliVersion, core: coreVersion, rfdb: rfdbVersion },
  };
}
```

---

## Output Formatting

### output.ts

```typescript
import type { DoctorCheckResult, DoctorReport } from './types.js';

// ANSI colors (same as check.ts)
const COLORS = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
  reset: '\x1b[0m',
};

const STATUS_ICONS: Record<string, string> = {
  pass: `${COLORS.green}✓${COLORS.reset}`,
  warn: `${COLORS.yellow}⚠${COLORS.reset}`,
  fail: `${COLORS.red}✗${COLORS.reset}`,
  skip: `${COLORS.dim}○${COLORS.reset}`,
};

/**
 * Format a single check result for console output.
 */
export function formatCheck(result: DoctorCheckResult, verbose: boolean): string {
  const icon = STATUS_ICONS[result.status];
  let output = `${icon} ${result.message}`;

  if (result.recommendation) {
    output += `\n  ${COLORS.dim}→${COLORS.reset} ${result.recommendation}`;
  }

  if (verbose && result.details) {
    const detailStr = JSON.stringify(result.details, null, 2)
      .split('\n')
      .map(line => `    ${COLORS.dim}${line}${COLORS.reset}`)
      .join('\n');
    output += `\n${detailStr}`;
  }

  return output;
}

/**
 * Format entrypoints tree (like user request example).
 */
export function formatEntrypointsTree(services: string[]): string {
  if (services.length === 0) return '';

  const lines = services.map((svc, i) => {
    const prefix = i === services.length - 1 ? '└─' : '├─';
    return `  ${prefix} ${svc}`;
  });

  return lines.join('\n');
}

/**
 * Format full report for console.
 */
export function formatReport(
  checks: DoctorCheckResult[],
  options: { quiet?: boolean; verbose?: boolean }
): string {
  const lines: string[] = [];

  if (!options.quiet) {
    lines.push('Checking Grafema setup...');
    lines.push('');
  }

  for (const check of checks) {
    if (options.quiet && check.status === 'pass') continue;
    lines.push(formatCheck(check, options.verbose || false));
  }

  // Summary
  const failCount = checks.filter(c => c.status === 'fail').length;
  const warnCount = checks.filter(c => c.status === 'warn').length;

  lines.push('');
  if (failCount > 0) {
    lines.push(`${COLORS.red}Status: ${failCount} error(s), ${warnCount} warning(s)${COLORS.reset}`);
  } else if (warnCount > 0) {
    lines.push(`${COLORS.yellow}Status: ${warnCount} warning(s)${COLORS.reset}`);
  } else {
    lines.push(`${COLORS.green}Status: All checks passed${COLORS.reset}`);
  }

  return lines.join('\n');
}

/**
 * Build JSON report structure.
 */
export function buildJsonReport(
  checks: DoctorCheckResult[],
  projectPath: string
): DoctorReport {
  const failCount = checks.filter(c => c.status === 'fail').length;
  const warnCount = checks.filter(c => c.status === 'warn').length;

  const status = failCount > 0 ? 'error' : warnCount > 0 ? 'warning' : 'healthy';
  const recommendations = checks
    .filter(c => c.recommendation)
    .map(c => c.recommendation!);

  // Extract versions from versions check
  const versionsCheck = checks.find(c => c.name === 'versions');
  const versions = (versionsCheck?.details as { cli?: string; core?: string; rfdb?: string }) || {
    cli: 'unknown',
    core: 'unknown',
  };

  return {
    status,
    timestamp: new Date().toISOString(),
    project: projectPath,
    checks,
    recommendations,
    versions: {
      cli: versions.cli || 'unknown',
      core: versions.core || 'unknown',
      rfdb: versions.rfdb,
    },
  };
}
```

---

## Main Command Implementation

### doctor.ts

```typescript
/**
 * Doctor command - Diagnose Grafema setup issues
 *
 * Checks:
 * 1. Initialization (.grafema directory, config file)
 * 2. Server status (RFDB server running)
 * 3. Config validity (syntax, plugin names)
 * 4. Entrypoints (service paths exist)
 * 5. Database exists and has data
 * 6. Graph statistics
 * 7. Graph connectivity
 * 8. Graph freshness
 * 9. Version information
 */

import { Command } from 'commander';
import { resolve } from 'path';
import {
  checkGrafemaInitialized,
  checkServerStatus,
  checkConfigValidity,
  checkEntrypoints,
  checkDatabaseExists,
  checkGraphStats,
  checkConnectivity,
  checkFreshness,
  checkVersions,
} from './doctor/checks.js';
import { formatReport, buildJsonReport } from './doctor/output.js';
import type { DoctorOptions, DoctorCheckResult } from './doctor/types.js';

export const doctorCommand = new Command('doctor')
  .description('Diagnose Grafema setup issues')
  .option('-p, --project <path>', 'Project path', '.')
  .option('-j, --json', 'Output as JSON')
  .option('-q, --quiet', 'Only show failures')
  .option('-v, --verbose', 'Show detailed diagnostics')
  .action(async (options: DoctorOptions) => {
    const projectPath = resolve(options.project);
    const checks: DoctorCheckResult[] = [];

    // Level 1: Prerequisites (fail-fast)
    const initCheck = await checkGrafemaInitialized(projectPath);
    checks.push(initCheck);

    if (initCheck.status === 'fail') {
      // Can't continue without initialization
      outputResults(checks, projectPath, options);
      process.exit(1);
    }

    // Level 2: Configuration
    checks.push(await checkConfigValidity(projectPath));
    checks.push(await checkEntrypoints(projectPath));

    // Server status (needed for Level 3 checks)
    const serverCheck = await checkServerStatus(projectPath);
    checks.push(serverCheck);

    // Level 3: Graph Health (requires database and optionally server)
    checks.push(await checkDatabaseExists(projectPath));

    if (serverCheck.status === 'pass') {
      // Server is running - can do full health checks
      checks.push(await checkGraphStats(projectPath));
      checks.push(await checkConnectivity(projectPath));
      checks.push(await checkFreshness(projectPath));
    }

    // Level 4: Informational
    checks.push(await checkVersions(projectPath));

    // Output results
    outputResults(checks, projectPath, options);

    // Exit code
    const failCount = checks.filter(c => c.status === 'fail').length;
    const warnCount = checks.filter(c => c.status === 'warn').length;

    if (failCount > 0) {
      process.exit(1);  // Critical issues
    } else if (warnCount > 0) {
      process.exit(2);  // Warnings only
    }
    // Exit 0 for all pass
  });

function outputResults(
  checks: DoctorCheckResult[],
  projectPath: string,
  options: DoctorOptions
): void {
  if (options.json) {
    const report = buildJsonReport(checks, projectPath);
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatReport(checks, options));
  }
}
```

---

## Dependencies

### Required imports from @grafema/core

```typescript
import {
  RFDBServerBackend,
  RFDBClient,
  loadConfig,
  GraphFreshnessChecker,
  resolveSourceEntrypoint,
} from '@grafema/core';
```

### BUILTIN_PLUGINS constant

Copy the `BUILTIN_PLUGINS` map from `analyze.ts` to a shared location, or import it:

```typescript
// Option A: Move to packages/cli/src/plugins/builtinPlugins.ts
// Option B: Just list the valid names for validation
export const VALID_PLUGIN_NAMES = new Set([
  'SimpleProjectDiscovery', 'MonorepoServiceDiscovery', 'WorkspaceDiscovery',
  'JSModuleIndexer', 'RustModuleIndexer',
  'JSASTAnalyzer', 'ExpressRouteAnalyzer', 'SocketIOAnalyzer', 'DatabaseAnalyzer',
  'FetchAnalyzer', 'ServiceLayerAnalyzer', 'ReactAnalyzer', 'RustAnalyzer',
  'MethodCallResolver', 'AliasTracker', 'ValueDomainAnalyzer', 'MountPointResolver',
  'PrefixEvaluator', 'InstanceOfResolver', 'ImportExportLinker', 'HTTPConnectionEnricher',
  'RustFFIEnricher',
  'CallResolverValidator', 'EvalBanValidator', 'SQLInjectionValidator', 'ShadowingDetector',
  'GraphConnectivityValidator', 'DataFlowValidator', 'TypeScriptDeadCodeValidator',
]);
```

---

## Test Cases

### Unit Tests: `test/commands/doctor.test.ts`

```typescript
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  checkGrafemaInitialized,
  checkConfigValidity,
  checkServerStatus,
  checkEntrypoints,
  checkDatabaseExists,
} from '../src/commands/doctor/checks.js';

describe('grafema doctor', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `grafema-doctor-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('checkGrafemaInitialized', () => {
    it('should fail when .grafema directory does not exist', async () => {
      const result = await checkGrafemaInitialized(testDir);
      assert.equal(result.status, 'fail');
      assert.ok(result.message.includes('not found'));
      assert.ok(result.recommendation?.includes('grafema init'));
    });

    it('should pass when config.yaml exists', async () => {
      mkdirSync(join(testDir, '.grafema'));
      writeFileSync(join(testDir, '.grafema', 'config.yaml'), 'plugins: {}');
      const result = await checkGrafemaInitialized(testDir);
      assert.equal(result.status, 'pass');
    });

    it('should warn when config.json exists (deprecated)', async () => {
      mkdirSync(join(testDir, '.grafema'));
      writeFileSync(join(testDir, '.grafema', 'config.json'), '{}');
      const result = await checkGrafemaInitialized(testDir);
      assert.equal(result.status, 'warn');
      assert.ok(result.recommendation?.includes('migrate'));
    });
  });

  describe('checkConfigValidity', () => {
    it('should fail on invalid YAML syntax', async () => {
      mkdirSync(join(testDir, '.grafema'));
      writeFileSync(join(testDir, '.grafema', 'config.yaml'), 'invalid: yaml: syntax:');
      const result = await checkConfigValidity(testDir);
      assert.equal(result.status, 'fail');
    });

    it('should warn on unknown plugin names', async () => {
      mkdirSync(join(testDir, '.grafema'));
      writeFileSync(join(testDir, '.grafema', 'config.yaml'), `
plugins:
  analysis:
    - NonExistentPlugin
`);
      const result = await checkConfigValidity(testDir);
      assert.equal(result.status, 'warn');
      assert.ok(result.message.includes('NonExistentPlugin'));
    });

    it('should pass with valid config', async () => {
      mkdirSync(join(testDir, '.grafema'));
      writeFileSync(join(testDir, '.grafema', 'config.yaml'), `
plugins:
  analysis:
    - JSASTAnalyzer
`);
      const result = await checkConfigValidity(testDir);
      assert.equal(result.status, 'pass');
    });
  });

  describe('checkServerStatus', () => {
    it('should warn when socket does not exist', async () => {
      mkdirSync(join(testDir, '.grafema'));
      const result = await checkServerStatus(testDir);
      assert.equal(result.status, 'warn');
      assert.ok(result.message.includes('not running'));
    });
  });

  describe('checkDatabaseExists', () => {
    it('should fail when database does not exist', async () => {
      mkdirSync(join(testDir, '.grafema'));
      const result = await checkDatabaseExists(testDir);
      assert.equal(result.status, 'fail');
      assert.ok(result.recommendation?.includes('grafema analyze'));
    });

    it('should warn on empty database', async () => {
      mkdirSync(join(testDir, '.grafema'));
      writeFileSync(join(testDir, '.grafema', 'graph.rfdb'), '');
      const result = await checkDatabaseExists(testDir);
      assert.equal(result.status, 'warn');
    });
  });
});
```

### Integration Test: `test/commands/doctor-integration.test.ts`

```typescript
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { execSync } from 'child_process';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('grafema doctor (integration)', () => {
  let testDir: string;
  const CLI = 'node --import tsx packages/cli/src/cli.ts';

  before(() => {
    testDir = join(tmpdir(), `grafema-doctor-int-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  after(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should exit with code 1 on uninitialized project', () => {
    try {
      execSync(`${CLI} doctor -p ${testDir}`, { stdio: 'pipe' });
      assert.fail('Should have exited with error');
    } catch (e) {
      assert.equal((e as { status: number }).status, 1);
    }
  });

  it('should support --json output', () => {
    try {
      const output = execSync(`${CLI} doctor -p ${testDir} --json`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const json = JSON.parse(output);
      assert.equal(json.status, 'error');
      assert.ok(Array.isArray(json.checks));
    } catch (e) {
      // Command exits with error, but should still output JSON
      const error = e as { stdout?: string };
      if (error.stdout) {
        const json = JSON.parse(error.stdout);
        assert.ok(json.status);
      }
    }
  });

  it('should show all checks passing on fully analyzed project', async () => {
    // This test requires a real project with analysis
    // Skip if grafema source directory doesn't exist
    const grafemaRoot = join(__dirname, '../../..');
    if (!existsSync(join(grafemaRoot, '.grafema', 'graph.rfdb'))) {
      console.log('Skipping: no analyzed grafema project available');
      return;
    }

    const output = execSync(`${CLI} doctor -p ${grafemaRoot}`, {
      encoding: 'utf-8',
    });
    assert.ok(output.includes('All checks passed') || output.includes('warning'));
  });
});
```

---

## Implementation Order

### Commit 1: Create types and interfaces
- Create `packages/cli/src/commands/doctor/types.ts`
- Define `DoctorCheckResult`, `DoctorOptions`, `DoctorReport`

### Commit 2: Implement output formatting
- Create `packages/cli/src/commands/doctor/output.ts`
- Implement `formatCheck`, `formatReport`, `buildJsonReport`
- Add color constants and status icons

### Commit 3: Implement Level 1 checks (prerequisites)
- Create `packages/cli/src/commands/doctor/checks.ts`
- Implement `checkGrafemaInitialized`
- Implement `checkServerStatus`

### Commit 4: Implement Level 2 checks (config validation)
- Implement `checkConfigValidity`
- Implement `checkEntrypoints`
- Add `VALID_PLUGIN_NAMES` set

### Commit 5: Implement Level 3 checks (graph health)
- Implement `checkDatabaseExists`
- Implement `checkGraphStats`
- Implement `checkConnectivity`
- Implement `checkFreshness`

### Commit 6: Implement Level 4 checks and main command
- Implement `checkVersions`
- Create `packages/cli/src/commands/doctor.ts`
- Wire up all checks with fail-fast logic

### Commit 7: Register command and add tests
- Add `doctorCommand` to `packages/cli/src/cli.ts`
- Create unit tests for each check function
- Create integration test

### Commit 8: Final polish and documentation
- Test all scenarios manually
- Ensure exit codes are correct (0/1/2)
- Update CLI help text

---

## Summary

This plan provides complete implementation details for `grafema doctor`:
- 9 diagnostic checks organized in 4 levels
- Consistent output formatting matching existing CLI style
- JSON output for CI/scripting
- Exit codes: 0 (healthy), 1 (errors), 2 (warnings)
- Full test coverage for each check

Key reuse:
- `GraphFreshnessChecker` for staleness detection
- `loadConfig` for config validation
- `RFDBClient.ping()` for server status and version
- `RFDBServerBackend.getStats()` for graph statistics
- Connectivity logic adapted from `GraphConnectivityValidator`

Ready for Kent Beck to write tests, then Rob Pike to implement.
