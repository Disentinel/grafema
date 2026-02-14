/**
 * Analysis Worker - runs in separate process to avoid blocking MCP server
 *
 * Usage: node analysis-worker.js <projectPath> [serviceName]
 *
 * Sends progress updates via IPC to parent process
 */

import { join } from 'path';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { pathToFileURL } from 'url';

import {
  Orchestrator,
  RFDBServerBackend,
  // Indexing
  JSModuleIndexer,
  // Analysis
  JSASTAnalyzer,
  ExpressRouteAnalyzer,
  ExpressResponseAnalyzer,
  NestJSRouteAnalyzer,
  SocketIOAnalyzer,
  DatabaseAnalyzer,
  FetchAnalyzer,
  ServiceLayerAnalyzer,
  ReactAnalyzer,
  // Enrichment
  MethodCallResolver,
  ArgumentParameterLinker,
  AliasTracker,
  ValueDomainAnalyzer,
  MountPointResolver,
  PrefixEvaluator,
  HTTPConnectionEnricher,
  RejectionPropagationEnricher,
  // Validation
  CallResolverValidator,
  EvalBanValidator,
  SQLInjectionValidator,
  ShadowingDetector,
  GraphConnectivityValidator,
  DataFlowValidator,
} from '@grafema/core';
import type { ParallelConfig ,
  Plugin} from '@grafema/core';

/**
 * Config structure
 */
interface WorkerConfig {
  plugins?: Record<string, string[]>;
  analysis?: {
    parallel?: ParallelConfig & { workers?: number; socketPath?: string };
  };
}

/**
 * Progress message
 */
interface ProgressMessage {
  type: 'progress';
  phase?: string;
  message?: string;
  servicesDiscovered?: number;
  servicesAnalyzed?: number;
}

/**
 * Complete message
 */
interface CompleteMessage {
  type: 'complete';
  nodeCount: number;
  edgeCount: number;
  totalTime: string;
}

/**
 * Error message
 */
interface ErrorMessage {
  type: 'error';
  message: string;
  stack?: string;
}


const projectPath = process.argv[2];
const serviceName = process.argv[3] && process.argv[3] !== '' ? process.argv[3] : null;
const indexOnly = process.argv[4] === 'indexOnly';

if (!projectPath) {
  console.error('Usage: node analysis-worker.js <projectPath> [serviceName] [indexOnly]');
  process.exit(1);
}

function sendProgress(data: Omit<ProgressMessage, 'type'>): void {
  if (process.send) {
    process.send({ type: 'progress', ...data } as ProgressMessage);
  }
}

function sendComplete(data: Omit<CompleteMessage, 'type'>): void {
  if (process.send) {
    process.send({ type: 'complete', ...data } as CompleteMessage);
  }
}

function sendError(error: Error): void {
  if (process.send) {
    process.send({ type: 'error', message: error.message, stack: error.stack } as ErrorMessage);
  }
}

async function loadConfig(): Promise<WorkerConfig> {
  const configPath = join(projectPath, '.grafema', 'config.json');
  if (existsSync(configPath)) {
    return JSON.parse(readFileSync(configPath, 'utf8')) as WorkerConfig;
  }
  return { plugins: {} };
}

async function loadCustomPlugins(): Promise<Record<string, new () => Plugin>> {
  const pluginsDir = join(projectPath, '.grafema', 'plugins');
  const customPlugins: Record<string, new () => Plugin> = {};

  if (!existsSync(pluginsDir)) {
    return customPlugins;
  }

  const files = readdirSync(pluginsDir).filter(f => f.endsWith('.mjs') || f.endsWith('.js'));
  for (const file of files) {
    try {
      const module = await import(pathToFileURL(join(pluginsDir, file)).href);
      const PluginClass = module.default as new () => Plugin;
      if (PluginClass) {
        customPlugins[PluginClass.name] = PluginClass;
      }
    } catch (err) {
      console.error(`Failed to load plugin ${file}:`, (err as Error).message);
    }
  }

  return customPlugins;
}

async function run(): Promise<void> {
  const startTime = Date.now();
  let db: RFDBServerBackend | null = null;

  try {
    sendProgress({ phase: 'starting', message: 'Loading configuration...' });

    const config = await loadConfig();
    const customPlugins = await loadCustomPlugins();

    // Built-in plugins map
    const builtinPlugins: Record<string, () => Plugin> = {
      JSModuleIndexer: () => new JSModuleIndexer(),
      JSASTAnalyzer: () => new JSASTAnalyzer(),
      ExpressRouteAnalyzer: () => new ExpressRouteAnalyzer(),
      ExpressResponseAnalyzer: () => new ExpressResponseAnalyzer(),
      NestJSRouteAnalyzer: () => new NestJSRouteAnalyzer(),
      SocketIOAnalyzer: () => new SocketIOAnalyzer(),
      DatabaseAnalyzer: () => new DatabaseAnalyzer(),
      FetchAnalyzer: () => new FetchAnalyzer(),
      ServiceLayerAnalyzer: () => new ServiceLayerAnalyzer(),
      ReactAnalyzer: () => new ReactAnalyzer(),
      MethodCallResolver: () => new MethodCallResolver(),
      ArgumentParameterLinker: () => new ArgumentParameterLinker(),
      AliasTracker: () => new AliasTracker(),
      ValueDomainAnalyzer: () => new ValueDomainAnalyzer(),
      MountPointResolver: () => new MountPointResolver(),
      PrefixEvaluator: () => new PrefixEvaluator(),
      HTTPConnectionEnricher: () => new HTTPConnectionEnricher(),
      RejectionPropagationEnricher: () => new RejectionPropagationEnricher(),
      CallResolverValidator: () => new CallResolverValidator(),
      EvalBanValidator: () => new EvalBanValidator(),
      SQLInjectionValidator: () => new SQLInjectionValidator(),
      ShadowingDetector: () => new ShadowingDetector(),
      GraphConnectivityValidator: () => new GraphConnectivityValidator(),
      DataFlowValidator: () => new DataFlowValidator(),
    };

    // Add custom plugins
    for (const [name, PluginClass] of Object.entries(customPlugins)) {
      builtinPlugins[name] = () => new PluginClass();
    }

    // Build plugins array from config
    const plugins: Plugin[] = [];
    for (const [_phase, pluginNames] of Object.entries(config.plugins || {})) {
      for (const name of pluginNames) {
        if (builtinPlugins[name]) {
          plugins.push(builtinPlugins[name]());
        } else if (customPlugins[name]) {
          plugins.push(new customPlugins[name]());
          console.log(`[Worker] Loaded custom plugin: ${name}`);
        } else {
          console.warn(`[Worker] Plugin not found: ${name}`);
        }
      }
    }

    console.log(`[Worker] Loaded ${plugins.length} plugins:`, plugins.map(p => p.metadata?.name || p.constructor?.name || 'unknown'));
    sendProgress({ phase: 'starting', message: `Loaded ${plugins.length} plugins` });

    // Get parallel analysis config
    const parallelConfig = config.analysis?.parallel;
    if (parallelConfig?.enabled) {
      console.log(`[Worker] Queue-based parallel mode enabled: workers=${parallelConfig.workers}`);
    }

    // Connect to RFDB server (shared with MCP server)
    // The MCP server starts the RFDB server if not running
    const dbPath = join(projectPath, '.grafema', 'graph.rfdb');
    const socketPath = config.analysis?.parallel?.socketPath || '/tmp/rfdb.sock';

    console.log(`[Worker] Connecting to RFDB server: socket=${socketPath}, db=${dbPath}`);
    db = new RFDBServerBackend({ socketPath, dbPath });
    await db.connect();

    // NOTE: db.clear() is NOT called here.
    // MCP server clears DB INSIDE the analysis lock BEFORE spawning this worker.
    // This prevents race conditions where concurrent analysis calls could both
    // clear the database. Worker assumes DB is already clean.
    // See: REG-159 implementation, Phase 2.5 (Worker Clear Coordination)

    sendProgress({ phase: 'discovery', message: 'Starting analysis...' });

    // Create orchestrator
    const orchestrator = new Orchestrator({
      graph: db,
      plugins,
      parallel: parallelConfig as ParallelConfig | undefined, // Pass parallel config for queue-based analysis
      serviceFilter: serviceName,
      indexOnly: indexOnly,
      onProgress: (progress) => {
        sendProgress({
          phase: progress.phase,
          message: progress.message,
          servicesAnalyzed: progress.servicesAnalyzed
        });
      }
    });

    // Run analysis
    await orchestrator.run(projectPath);

    // Get final stats
    let nodeCount = 0;
    let edgeCount = 0;

    // Use async methods for RFDBServerBackend
    const allEdges = await db.getAllEdgesAsync();
    edgeCount = allEdges.length;

    for await (const _node of db.queryNodes({})) {
      nodeCount++;
    }

    // Flush to disk using proper async method
    console.log('[Worker] Flushing database to disk...');
    await db.flush();
    console.log('[Worker] Database flushed successfully');

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);

    sendComplete({
      nodeCount,
      edgeCount,
      totalTime
    });

    // Close database properly before exit
    await db.close();
    console.log('[Worker] Database closed');

    process.exit(0);
  } finally {
    // Ensure database connection is closed even on error
    if (db && db.connected) {
      try {
        await db.close();
        console.log('[Worker] Database connection closed in cleanup');
      } catch (closeErr) {
        const message = closeErr instanceof Error ? closeErr.message : String(closeErr);
        console.error('[Worker] Error closing database connection:', message);
      }
    }
  }
}

run().catch(err => {
  const error = err instanceof Error ? err : new Error(String(err));
  sendError(error);
  console.error('Analysis failed:', err);
  process.exit(1);
});
