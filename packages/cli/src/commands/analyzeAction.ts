/**
 * Analyze command action — connects to RFDB, loads plugins, runs Orchestrator.
 *
 * Extracted from analyze.ts (REG-435) to keep command definition separate
 * from execution logic.
 */

import { resolve, join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import {
  Orchestrator,
  RFDBServerBackend,
  DiagnosticReporter,
  DiagnosticWriter,
  createLogger,
  loadConfig,
  StrictModeFailure,
} from '@grafema/core';
import type { LogLevel, GraphBackend } from '@grafema/types';
import { ProgressRenderer } from '../utils/progressRenderer.js';
import { loadCustomPlugins, createPlugins } from '../plugins/pluginLoader.js';

export interface NodeEdgeCountBackend {
  nodeCount: () => Promise<number>;
  edgeCount: () => Promise<number>;
}

export async function fetchNodeEdgeCounts(backend: NodeEdgeCountBackend): Promise<{ nodeCount: number; edgeCount: number }> {
  const [nodeCount, edgeCount] = await Promise.all([backend.nodeCount(), backend.edgeCount()]);
  return { nodeCount, edgeCount };
}

export function exitWithCode(code: number, exitFn: (code: number) => void = process.exit): void {
  exitFn(code);
}

/**
 * Determine log level from CLI options.
 * Priority: --log-level > --quiet > --verbose > default ('silent')
 *
 * By default, logs are silent to allow clean progress UI.
 * Use --verbose to see detailed logs (disables interactive progress).
 */
function getLogLevel(options: { quiet?: boolean; verbose?: boolean; logLevel?: string }): LogLevel {
  if (options.logLevel) {
    const validLevels: LogLevel[] = ['silent', 'errors', 'warnings', 'info', 'debug'];
    if (validLevels.includes(options.logLevel as LogLevel)) {
      return options.logLevel as LogLevel;
    }
  }
  if (options.quiet) return 'silent';
  if (options.verbose) return 'info';  // --verbose shows logs instead of progress UI
  return 'silent';  // Default: silent logs, clean progress UI
}

export async function analyzeAction(path: string, options: { service?: string; entrypoint?: string; clear?: boolean; quiet?: boolean; verbose?: boolean; debug?: boolean; logLevel?: string; logFile?: string; strict?: boolean; autoStart?: boolean; engine?: string }): Promise<void> {
  const projectPath = resolve(path);
  const grafemaDir = join(projectPath, '.grafema');
  const dbPath = join(grafemaDir, 'graph.rfdb');

  if (!existsSync(grafemaDir)) {
    mkdirSync(grafemaDir, { recursive: true });
  }

  // Two log levels for CLI output:
  // - info: important results (shows unless --quiet)
  // - debug: verbose details (shows only with --verbose)
  const info = options.quiet ? () => {} : console.log;
  const debug = options.verbose ? console.log : () => {};

  // Create logger based on CLI flags
  const logLevel = getLogLevel(options);
  const logFile = options.logFile ? resolve(options.logFile) : undefined;
  const logger = createLogger(logLevel, logFile ? { logFile } : undefined);

  if (logFile) {
    debug(`Log file: ${logFile}`);
  }
  debug(`Analyzing project: ${projectPath}`);

  // Connect to RFDB server
  // Default: require explicit `grafema server start`
  // Use --auto-start for CI or backwards compatibility
  // In normal mode (not verbose), suppress backend logs for clean progress UI
  const backend = new RFDBServerBackend({
    dbPath,
    autoStart: options.autoStart ?? false,
    silent: !options.verbose,  // Silent in normal mode (show progress), verbose shows logs
    clientName: 'cli'
  });

  try {
    await backend.connect();
  } catch (err) {
    if (!options.autoStart && err instanceof Error && err.message.includes('not running')) {
      console.error('');
      console.error('RFDB server is not running.');
      console.error('');
      console.error('Start the server first:');
      console.error('  grafema server start');
      console.error('');
      console.error('Or use --auto-start flag:');
      console.error('  grafema analyze --auto-start');
      console.error('');
      process.exit(1);
    }
    throw err;
  }

  if (options.clear) {
    debug('Clearing existing database...');
    await backend.clear();
  }

  const config = loadConfig(projectPath, logger);

  // Switch to core-v2 engine if requested
  if (options.engine === 'v2') {
    debug('Using core-v2 analysis engine');
    config.plugins.analysis = ['CoreV2Analyzer'];
    config.plugins.enrichment = [];
    config.plugins.validation = [];
  }

  // Extract services from config (REG-174)
  if (config.services.length > 0) {
    debug(`Loaded ${config.services.length} service(s) from config`);
    for (const svc of config.services) {
      const entry = svc.entryPoint ? ` (entry: ${svc.entryPoint})` : '';
      debug(`  - ${svc.name}: ${svc.path}${entry}`);
    }
  }

  // Load custom plugins from .grafema/plugins/
  const customPlugins = await loadCustomPlugins(projectPath, debug);
  const plugins = createPlugins(config.plugins, customPlugins, options.verbose);

  debug(`Loaded ${plugins.length} plugins`);

  // Resolve strict mode: CLI flag overrides config
  const strictMode = options.strict ?? config.strict ?? false;
  if (strictMode) {
    debug('Strict mode enabled - analysis will fail on unresolved references');
  }

  const startTime = Date.now();

  // Create progress renderer for CLI output
  // In quiet mode, use a no-op renderer (skip rendering)
  // In verbose mode, use non-interactive (newlines per update)
  // In normal mode, use interactive (spinner with line overwrite)
  const renderer = options.quiet
    ? null
    : new ProgressRenderer({
        isInteractive: !options.verbose && process.stdout.isTTY,
      });

  // Poll graph stats periodically to show node/edge counts in progress
  let statsInterval: NodeJS.Timeout | null = null;
  if (renderer && !options.quiet) {
    statsInterval = setInterval(async () => {
      try {
        const stats = await fetchNodeEdgeCounts(backend);
        renderer.setStats(stats.nodeCount, stats.edgeCount);
      } catch {
        // Ignore stats errors during analysis
      }
    }, 500); // Poll every 500ms
    statsInterval.unref?.();
  }

  const orchestrator = new Orchestrator({
    graph: backend as unknown as GraphBackend,
    plugins,
    serviceFilter: options.service || null,
    entrypoint: options.entrypoint,
    forceAnalysis: options.clear || false,
    logger,
    services: config.services.length > 0 ? config.services : undefined,  // Pass config services (REG-174)
    strictMode, // REG-330: Pass strict mode flag
    onProgress: (progress) => {
      renderer?.update(progress);
    },
  });

  let exitCode = 0;

  try {
    await orchestrator.run(projectPath);
    await backend.flush();

    const elapsedSeconds = (Date.now() - startTime) / 1000;
    const stats = await fetchNodeEdgeCounts(backend);

    // Clear progress line in interactive mode, then show results
    if (renderer && process.stdout.isTTY) {
      process.stdout.write('\r\x1b[K'); // Clear line
    }
    info('');
    info(renderer ? renderer.finish(elapsedSeconds) : `Analysis complete in ${elapsedSeconds.toFixed(2)}s`);
    info(`  Nodes: ${stats.nodeCount}`);
    info(`  Edges: ${stats.edgeCount}`);

    // Get diagnostics and report summary
    const diagnostics = orchestrator.getDiagnostics();
    const reporter = new DiagnosticReporter(diagnostics);

    // Print summary if there are any issues
    if (diagnostics.count() > 0) {
      info('');
      info(reporter.categorizedSummary());

      // In verbose mode, print full report
      if (options.verbose) {
        debug('');
        debug(reporter.report({ format: 'text', includeSummary: false }));
      }
    }

    // Always write diagnostics.log (required for `grafema check` command)
    const writer = new DiagnosticWriter();
    await writer.write(diagnostics, grafemaDir);
    if (options.debug) {
      debug(`Diagnostics written to ${writer.getLogPath(grafemaDir)}`);
    }

    // Determine exit code based on severity
    if (diagnostics.hasFatal()) {
      exitCode = 1;
    } else if (diagnostics.hasErrors()) {
      exitCode = 2; // Completed with errors
    } else {
      exitCode = 0; // Success (maybe warnings)
    }
  } catch (e) {
    const diagnostics = orchestrator.getDiagnostics();
    const reporter = new DiagnosticReporter(diagnostics);

    // Clear progress line in interactive mode
    if (renderer && process.stdout.isTTY) {
      process.stdout.write('\r\x1b[K');
    }

    // Check if this is a strict mode failure (REG-332: structured output)
    if (e instanceof StrictModeFailure) {
      // Format ONLY from diagnostics, not from error.message
      console.error('');
      console.error(`✗ Strict mode: ${e.count} unresolved reference(s) found during ENRICHMENT.`);
      console.error('');
      console.error(reporter.formatStrict(e.diagnostics, {
        verbose: options.verbose,
        suppressedCount: e.suppressedCount,  // REG-332
      }));
      console.error('');
      console.error('Run without --strict for graceful degradation, or fix the underlying issues.');
    } else {
      // Generic error handling (non-strict)
      const error = e instanceof Error ? e : new Error(String(e));
      console.error('');
      console.error(`✗ Analysis failed: ${error.message}`);
      console.error('');
      console.error('→ Run with --debug for detailed diagnostics');

      if (diagnostics.count() > 0) {
        console.error('');
        console.error(reporter.report({ format: 'text', includeSummary: true }));
      }
    }

    // Write diagnostics.log in debug mode even on failure
    if (options.debug) {
      const writer = new DiagnosticWriter();
      await writer.write(diagnostics, grafemaDir);
      console.error(`Diagnostics written to ${writer.getLogPath(grafemaDir)}`);
    }

    exitCode = 1;
  } finally {
    // Stop stats polling
    if (statsInterval) {
      clearInterval(statsInterval);
      statsInterval = null;
    }

    if (backend.connected) {
      await backend.close();
    }

    // Exit with appropriate code
    // 0 = success, 1 = fatal, 2 = errors
    exitWithCode(exitCode);
  }
}
