/**
 * Analyze command - Run project analysis via Orchestrator
 */

import { Command } from 'commander';
import { resolve, join } from 'path';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import {
  Orchestrator,
  RFDBServerBackend,
  Plugin,
  // Indexing
  JSModuleIndexer,
  RustModuleIndexer,
  // Analysis
  JSASTAnalyzer,
  ExpressRouteAnalyzer,
  SocketIOAnalyzer,
  DatabaseAnalyzer,
  FetchAnalyzer,
  ServiceLayerAnalyzer,
  ReactAnalyzer,
  RustAnalyzer,
  // Enrichment
  MethodCallResolver,
  AliasTracker,
  ValueDomainAnalyzer,
  MountPointResolver,
  PrefixEvaluator,
  InstanceOfResolver,
  ImportExportLinker,
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
} from '@grafema/core';

interface PluginConfig {
  indexing?: string[];
  analysis?: string[];
  enrichment?: string[];
  validation?: string[];
}

interface ProjectConfig {
  plugins?: PluginConfig;
}

const BUILTIN_PLUGINS: Record<string, () => Plugin> = {
  // Indexing
  JSModuleIndexer: () => new JSModuleIndexer() as Plugin,
  RustModuleIndexer: () => new RustModuleIndexer() as Plugin,
  // Analysis
  JSASTAnalyzer: () => new JSASTAnalyzer() as Plugin,
  ExpressRouteAnalyzer: () => new ExpressRouteAnalyzer() as Plugin,
  SocketIOAnalyzer: () => new SocketIOAnalyzer() as Plugin,
  DatabaseAnalyzer: () => new DatabaseAnalyzer() as Plugin,
  FetchAnalyzer: () => new FetchAnalyzer() as Plugin,
  ServiceLayerAnalyzer: () => new ServiceLayerAnalyzer() as Plugin,
  ReactAnalyzer: () => new ReactAnalyzer() as Plugin,
  RustAnalyzer: () => new RustAnalyzer() as Plugin,
  // Enrichment
  MethodCallResolver: () => new MethodCallResolver() as Plugin,
  AliasTracker: () => new AliasTracker() as Plugin,
  ValueDomainAnalyzer: () => new ValueDomainAnalyzer() as Plugin,
  MountPointResolver: () => new MountPointResolver() as Plugin,
  PrefixEvaluator: () => new PrefixEvaluator() as Plugin,
  InstanceOfResolver: () => new InstanceOfResolver() as Plugin,
  ImportExportLinker: () => new ImportExportLinker() as Plugin,
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
};

const DEFAULT_PLUGINS: PluginConfig = {
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
};

function loadConfig(projectPath: string): ProjectConfig {
  const configPath = join(projectPath, '.grafema', 'config.json');
  if (!existsSync(configPath)) {
    return { plugins: DEFAULT_PLUGINS };
  }
  try {
    const content = readFileSync(configPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return { plugins: DEFAULT_PLUGINS };
  }
}

function createPlugins(config: PluginConfig): Plugin[] {
  const plugins: Plugin[] = [];
  const phases: (keyof PluginConfig)[] = ['indexing', 'analysis', 'enrichment', 'validation'];

  for (const phase of phases) {
    const names = config[phase] || [];
    for (const name of names) {
      const factory = BUILTIN_PLUGINS[name];
      if (factory) {
        plugins.push(factory());
      } else {
        console.warn(`Unknown plugin: ${name}`);
      }
    }
  }

  return plugins;
}

export const analyzeCommand = new Command('analyze')
  .description('Run project analysis')
  .argument('[path]', 'Project path to analyze', '.')
  .option('-s, --service <name>', 'Analyze only a specific service')
  .option('-c, --clear', 'Clear existing database before analysis')
  .option('-q, --quiet', 'Suppress progress output')
  .action(async (path: string, options: { service?: string; clear?: boolean; quiet?: boolean }) => {
    const projectPath = resolve(path);
    const grafemaDir = join(projectPath, '.grafema');
    const dbPath = join(grafemaDir, 'graph.rfdb');

    if (!existsSync(grafemaDir)) {
      mkdirSync(grafemaDir, { recursive: true });
    }

    const log = options.quiet ? () => {} : console.log;

    log(`Analyzing project: ${projectPath}`);

    const backend = new RFDBServerBackend({ dbPath });
    await backend.connect();

    if (options.clear) {
      log('Clearing existing database...');
      await backend.clear();
    }

    const config = loadConfig(projectPath);
    const plugins = createPlugins(config.plugins || DEFAULT_PLUGINS);

    log(`Loaded ${plugins.length} plugins`);

    const startTime = Date.now();

    const orchestrator = new Orchestrator({
      graph: backend as unknown as import('@grafema/types').GraphBackend,
      plugins,
      serviceFilter: options.service || null,
      forceAnalysis: options.clear || false,
      onProgress: (progress) => {
        log(`[${progress.phase}] ${progress.message}`);
      },
    });

    await orchestrator.run(projectPath);
    await backend.flush();

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    const stats = await backend.getStats();

    log('');
    log(`Analysis complete in ${elapsed}s`);
    log(`  Nodes: ${stats.nodeCount}`);
    log(`  Edges: ${stats.edgeCount}`);

    await backend.close();
  });
