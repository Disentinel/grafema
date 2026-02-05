/**
 * Analyze command - Run project analysis via Orchestrator
 */

import { Command } from 'commander';
import { resolve, join } from 'path';
import { existsSync, mkdirSync, readdirSync } from 'fs';
import { pathToFileURL } from 'url';
import {
  Orchestrator,
  RFDBServerBackend,
  Plugin,
  DiagnosticReporter,
  DiagnosticWriter,
  createLogger,
  loadConfig,
  type GrafemaConfig,
  // Discovery
  SimpleProjectDiscovery,
  MonorepoServiceDiscovery,
  WorkspaceDiscovery,
  // Indexing
  JSModuleIndexer,
  RustModuleIndexer,
  // Analysis
  JSASTAnalyzer,
  ExpressRouteAnalyzer,
  ExpressResponseAnalyzer,
  SocketIOAnalyzer,
  DatabaseAnalyzer,
  FetchAnalyzer,
  ServiceLayerAnalyzer,
  ReactAnalyzer,
  RustAnalyzer,
  // Enrichment
  MethodCallResolver,
  ArgumentParameterLinker,
  AliasTracker,
  ValueDomainAnalyzer,
  MountPointResolver,
  PrefixEvaluator,
  InstanceOfResolver,
  ImportExportLinker,
  FunctionCallResolver,
  HTTPConnectionEnricher,
  RustFFIEnricher,
  // Validation
  CallResolverValidator,
  EvalBanValidator,
  SQLInjectionValidator,
  ShadowingDetector,
  GraphConnectivityValidator,
  DataFlowValidator,
  TypeScriptDeadCodeValidator,
  BrokenImportValidator,
} from '@grafema/core';
import type { LogLevel } from '@grafema/types';
import { ProgressRenderer } from '../utils/progressRenderer.js';

const BUILTIN_PLUGINS: Record<string, () => Plugin> = {
  // Discovery
  SimpleProjectDiscovery: () => new SimpleProjectDiscovery() as Plugin,
  MonorepoServiceDiscovery: () => new MonorepoServiceDiscovery() as Plugin,
  WorkspaceDiscovery: () => new WorkspaceDiscovery() as Plugin,
  // Indexing
  JSModuleIndexer: () => new JSModuleIndexer() as Plugin,
  RustModuleIndexer: () => new RustModuleIndexer() as Plugin,
  // Analysis
  JSASTAnalyzer: () => new JSASTAnalyzer() as Plugin,
  ExpressRouteAnalyzer: () => new ExpressRouteAnalyzer() as Plugin,
  ExpressResponseAnalyzer: () => new ExpressResponseAnalyzer() as Plugin,
  SocketIOAnalyzer: () => new SocketIOAnalyzer() as Plugin,
  DatabaseAnalyzer: () => new DatabaseAnalyzer() as Plugin,
  FetchAnalyzer: () => new FetchAnalyzer() as Plugin,
  ServiceLayerAnalyzer: () => new ServiceLayerAnalyzer() as Plugin,
  ReactAnalyzer: () => new ReactAnalyzer() as Plugin,
  RustAnalyzer: () => new RustAnalyzer() as Plugin,
  // Enrichment
  MethodCallResolver: () => new MethodCallResolver() as Plugin,
  ArgumentParameterLinker: () => new ArgumentParameterLinker() as Plugin,
  AliasTracker: () => new AliasTracker() as Plugin,
  ValueDomainAnalyzer: () => new ValueDomainAnalyzer() as Plugin,
  MountPointResolver: () => new MountPointResolver() as Plugin,
  PrefixEvaluator: () => new PrefixEvaluator() as Plugin,
  InstanceOfResolver: () => new InstanceOfResolver() as Plugin,
  ImportExportLinker: () => new ImportExportLinker() as Plugin,
  FunctionCallResolver: () => new FunctionCallResolver() as Plugin,
  HTTPConnectionEnricher: () => new HTTPConnectionEnricher() as Plugin,
  RustFFIEnricher: () => new RustFFIEnricher() as Plugin,
  // Validation
  CallResolverValidator: () => new CallResolverValidator() as Plugin,
  EvalBanValidator: () => new EvalBanValidator() as Plugin,
  SQLInjectionValidator: () => new SQLInjectionValidator() as Plugin,
  ShadowingDetector: () => new ShadowingDetector() as Plugin,
  GraphConnectivityValidator: () => new GraphConnectivityValidator() as Plugin,
  DataFlowValidator: () => new DataFlowValidator() as Plugin,
  TypeScriptDeadCodeValidator: () => new TypeScriptDeadCodeValidator() as Plugin,
  BrokenImportValidator: () => new BrokenImportValidator() as Plugin,
};

/**
 * Load custom plugins from .grafema/plugins/ directory
 */
async function loadCustomPlugins(
  projectPath: string,
  log: (msg: string) => void
): Promise<Record<string, () => Plugin>> {
  const pluginsDir = join(projectPath, '.grafema', 'plugins');
  if (!existsSync(pluginsDir)) {
    return {};
  }

  const customPlugins: Record<string, () => Plugin> = {};

  try {
    const files = readdirSync(pluginsDir).filter(
      (f) => f.endsWith('.js') || f.endsWith('.mjs') || f.endsWith('.cjs')
    );

    for (const file of files) {
      try {
        const pluginPath = join(pluginsDir, file);
        const pluginUrl = pathToFileURL(pluginPath).href;
        const module = await import(pluginUrl);

        const PluginClass = module.default || module[file.replace(/\.[cm]?js$/, '')];
        if (PluginClass && typeof PluginClass === 'function') {
          const pluginName = PluginClass.name || file.replace(/\.[cm]?js$/, '');
          customPlugins[pluginName] = () => new PluginClass() as Plugin;
          log(`Loaded custom plugin: ${pluginName}`);
        }
      } catch (err) {
        console.warn(`Failed to load plugin ${file}: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    console.warn(`Error loading custom plugins: ${(err as Error).message}`);
  }

  return customPlugins;
}

function createPlugins(
  config: GrafemaConfig['plugins'],
  customPlugins: Record<string, () => Plugin> = {}
): Plugin[] {
  const plugins: Plugin[] = [];
  const phases: (keyof GrafemaConfig['plugins'])[] = ['discovery', 'indexing', 'analysis', 'enrichment', 'validation'];

  for (const phase of phases) {
    const names = config[phase] || [];
    for (const name of names) {
      // Check built-in first, then custom
      const factory = BUILTIN_PLUGINS[name] || customPlugins[name];
      if (factory) {
        plugins.push(factory());
      } else {
        console.warn(`Plugin not found: ${name} (skipping). Check .grafema/config.yaml or add to .grafema/plugins/`);
      }
    }
  }

  return plugins;
}

/**
 * Determine log level from CLI options.
 * Priority: --log-level > --quiet > --verbose > default ('info')
 */
function getLogLevel(options: { quiet?: boolean; verbose?: boolean; logLevel?: string }): LogLevel {
  if (options.logLevel) {
    const validLevels: LogLevel[] = ['silent', 'errors', 'warnings', 'info', 'debug'];
    if (validLevels.includes(options.logLevel as LogLevel)) {
      return options.logLevel as LogLevel;
    }
  }
  if (options.quiet) return 'silent';
  if (options.verbose) return 'debug';
  return 'info';
}

export const analyzeCommand = new Command('analyze')
  .description('Run project analysis')
  .argument('[path]', 'Project path to analyze', '.')
  .option('-s, --service <name>', 'Analyze only a specific service')
  .option('-e, --entrypoint <path>', 'Override entrypoint (bypasses auto-detection)')
  .option('-c, --clear', 'Clear existing database before analysis')
  .option('-q, --quiet', 'Suppress progress output')
  .option('-v, --verbose', 'Show verbose logging')
  .option('--debug', 'Enable debug mode (writes diagnostics.log)')
  .option('--log-level <level>', 'Set log level (silent, errors, warnings, info, debug)')
  .option('--strict', 'Enable strict mode (fail on unresolved references)')
  .option('--auto-start', 'Auto-start RFDB server if not running')
  .addHelpText('after', `
Examples:
  grafema analyze                Analyze current project
  grafema analyze ./my-project   Analyze specific directory
  grafema analyze --clear        Clear database and rebuild from scratch
  grafema analyze -s api         Analyze only "api" service (monorepo)
  grafema analyze -v             Verbose output with progress details
  grafema analyze --debug        Write diagnostics.log for debugging
  grafema analyze --strict       Fail on unresolved references (debugging)
  grafema analyze --auto-start   Auto-start server (useful for CI)

Note: Start the server first with: grafema server start
`)
  .action(async (path: string, options: { service?: string; entrypoint?: string; clear?: boolean; quiet?: boolean; verbose?: boolean; debug?: boolean; logLevel?: string; strict?: boolean; autoStart?: boolean }) => {
    const projectPath = resolve(path);
    const grafemaDir = join(projectPath, '.grafema');
    const dbPath = join(grafemaDir, 'graph.rfdb');

    if (!existsSync(grafemaDir)) {
      mkdirSync(grafemaDir, { recursive: true });
    }

    const log = options.quiet ? () => {} : console.log;

    // Create logger based on CLI flags
    const logLevel = getLogLevel(options);
    const logger = createLogger(logLevel);

    log(`Analyzing project: ${projectPath}`);

    // Connect to RFDB server
    // Default: require explicit `grafema server start`
    // Use --auto-start for CI or backwards compatibility
    const backend = new RFDBServerBackend({
      dbPath,
      autoStart: options.autoStart ?? false
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
      log('Clearing existing database...');
      await backend.clear();
    }

    const config = loadConfig(projectPath, logger);

    // Extract services from config (REG-174)
    if (config.services.length > 0) {
      log(`Loaded ${config.services.length} service(s) from config`);
      for (const svc of config.services) {
        const entry = svc.entryPoint ? ` (entry: ${svc.entryPoint})` : '';
        log(`  - ${svc.name}: ${svc.path}${entry}`);
      }
    }

    // Load custom plugins from .grafema/plugins/
    const customPlugins = await loadCustomPlugins(projectPath, log);
    const plugins = createPlugins(config.plugins, customPlugins);

    log(`Loaded ${plugins.length} plugins`);

    // Resolve strict mode: CLI flag overrides config
    const strictMode = options.strict ?? config.strict ?? false;
    if (strictMode) {
      log('Strict mode enabled - analysis will fail on unresolved references');
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

    const orchestrator = new Orchestrator({
      graph: backend as unknown as import('@grafema/types').GraphBackend,
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
      const stats = await backend.getStats();

      // Clear progress line in interactive mode, then show results
      if (renderer && process.stdout.isTTY) {
        process.stdout.write('\r\x1b[K'); // Clear line
      }
      log('');
      log(renderer ? renderer.finish(elapsedSeconds) : `Analysis complete in ${elapsedSeconds.toFixed(2)}s`);
      log(`  Nodes: ${stats.nodeCount}`);
      log(`  Edges: ${stats.edgeCount}`);

      // Get diagnostics and report summary
      const diagnostics = orchestrator.getDiagnostics();
      const reporter = new DiagnosticReporter(diagnostics);

      // Print summary if there are any issues
      if (diagnostics.count() > 0) {
        log('');
        log(reporter.categorizedSummary());

        // In verbose mode, print full report
        if (options.verbose) {
          log('');
          log(reporter.report({ format: 'text', includeSummary: false }));
        }
      }

      // Always write diagnostics.log (required for `grafema check` command)
      const writer = new DiagnosticWriter();
      await writer.write(diagnostics, grafemaDir);
      if (options.debug) {
        log(`Diagnostics written to ${writer.getLogPath(grafemaDir)}`);
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
      // Orchestrator threw (fatal error stopped analysis)
      const error = e instanceof Error ? e : new Error(String(e));
      const diagnostics = orchestrator.getDiagnostics();
      const reporter = new DiagnosticReporter(diagnostics);

      console.error('');
      console.error(`✗ Analysis failed: ${error.message}`);
      console.error('');
      console.error('→ Run with --debug for detailed diagnostics');

      if (diagnostics.count() > 0) {
        console.error('');
        console.error(reporter.report({ format: 'text', includeSummary: true }));
      }

      // Write diagnostics.log in debug mode even on failure
      if (options.debug) {
        const writer = new DiagnosticWriter();
        await writer.write(diagnostics, grafemaDir);
        console.error(`Diagnostics written to ${writer.getLogPath(grafemaDir)}`);
      }

      exitCode = 1;
    }

    await backend.close();

    // Exit with appropriate code
    // 0 = success, 1 = fatal, 2 = errors
    if (exitCode !== 0) {
      process.exit(exitCode);
    }
  });
