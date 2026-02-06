/**
 * MCP Server Configuration
 */

import { join } from 'path';
import { existsSync, readdirSync } from 'fs';
import { pathToFileURL } from 'url';
import { log } from './utils.js';
import { loadConfig as loadConfigFromCore, type GrafemaConfig } from '@grafema/core';

// === PLUGIN IMPORTS ===
import {
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
  HTTPConnectionEnricher,
  RustFFIEnricher,
  RejectionPropagationEnricher,
  // Validation
  CallResolverValidator,
  EvalBanValidator,
  SQLInjectionValidator,
  ShadowingDetector,
  GraphConnectivityValidator,
  DataFlowValidator,
  TypeScriptDeadCodeValidator,
} from '@grafema/core';

// === MCP-SPECIFIC CONFIG ===
/**
 * MCP-specific configuration extends GrafemaConfig with additional fields.
 */
export interface MCPConfig extends GrafemaConfig {
  discovery?: {
    enabled: boolean;
    customOnly: boolean;
  };
  analysis?: {
    service?: string;
  };
  backend?: 'local' | 'rfdb';
  rfdb_socket?: string;
}

const MCP_DEFAULTS: Pick<MCPConfig, 'discovery'> = {
  discovery: {
    enabled: true,
    customOnly: false,
  },
};

// === BUILTIN PLUGINS ===
type PluginFactory = () => unknown;

export const BUILTIN_PLUGINS: Record<string, PluginFactory> = {
  // Indexing
  JSModuleIndexer: () => new JSModuleIndexer(),
  RustModuleIndexer: () => new RustModuleIndexer(),

  // Analysis
  JSASTAnalyzer: () => new JSASTAnalyzer(),
  ExpressRouteAnalyzer: () => new ExpressRouteAnalyzer(),
  ExpressResponseAnalyzer: () => new ExpressResponseAnalyzer(),
  SocketIOAnalyzer: () => new SocketIOAnalyzer(),
  DatabaseAnalyzer: () => new DatabaseAnalyzer(),
  FetchAnalyzer: () => new FetchAnalyzer(),
  ServiceLayerAnalyzer: () => new ServiceLayerAnalyzer(),
  ReactAnalyzer: () => new ReactAnalyzer(),
  RustAnalyzer: () => new RustAnalyzer(),

  // Enrichment
  MethodCallResolver: () => new MethodCallResolver(),
  ArgumentParameterLinker: () => new ArgumentParameterLinker(),
  AliasTracker: () => new AliasTracker(),
  ValueDomainAnalyzer: () => new ValueDomainAnalyzer(),
  MountPointResolver: () => new MountPointResolver(),
  PrefixEvaluator: () => new PrefixEvaluator(),
  InstanceOfResolver: () => new InstanceOfResolver(),
  HTTPConnectionEnricher: () => new HTTPConnectionEnricher(),
  RustFFIEnricher: () => new RustFFIEnricher(),
  RejectionPropagationEnricher: () => new RejectionPropagationEnricher(),

  // Validation
  CallResolverValidator: () => new CallResolverValidator(),
  EvalBanValidator: () => new EvalBanValidator(),
  SQLInjectionValidator: () => new SQLInjectionValidator(),
  ShadowingDetector: () => new ShadowingDetector(),
  GraphConnectivityValidator: () => new GraphConnectivityValidator(),
  DataFlowValidator: () => new DataFlowValidator(),
  TypeScriptDeadCodeValidator: () => new TypeScriptDeadCodeValidator(),
};

// === CONFIG LOADING ===
/**
 * Load MCP configuration (extends base GrafemaConfig).
 * Uses shared ConfigLoader but adds MCP-specific defaults.
 */
export function loadConfig(projectPath: string): MCPConfig {
  // Use shared loader (handles YAML/JSON, deprecation warnings)
  const baseConfig = loadConfigFromCore(projectPath, {
    warn: (msg) => log(`[Grafema MCP] ${msg}`),
  });

  // Add MCP-specific defaults
  return {
    ...baseConfig,
    ...MCP_DEFAULTS,
  };
}

// === CUSTOM PLUGINS ===
export interface CustomPluginResult {
  plugins: unknown[];
  pluginMap: Record<string, new () => unknown>;
}

export async function loadCustomPlugins(projectPath: string): Promise<CustomPluginResult> {
  const pluginsDir = join(projectPath, '.grafema', 'plugins');
  if (!existsSync(pluginsDir)) {
    return { plugins: [], pluginMap: {} };
  }

  const customPlugins: unknown[] = [];
  const pluginMap: Record<string, new () => unknown> = {};

  try {
    const files = readdirSync(pluginsDir).filter(
      (f) => f.endsWith('.js') || f.endsWith('.mjs')
    );

    for (const file of files) {
      try {
        const pluginPath = join(pluginsDir, file);
        const pluginUrl = pathToFileURL(pluginPath).href;
        const module = await import(pluginUrl);

        const PluginClass = module.default || module[file.replace(/\.(m?js)$/, '')];
        if (PluginClass && typeof PluginClass === 'function') {
          const pluginName = PluginClass.name || file.replace(/\.(m?js)$/, '');
          customPlugins.push(new PluginClass());
          pluginMap[pluginName] = PluginClass;
          log(`[Grafema MCP] Loaded custom plugin: ${pluginName} from ${file}`);
        }
      } catch (err) {
        log(`[Grafema MCP] Failed to load plugin ${file}: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    log(`[Grafema MCP] Error loading custom plugins: ${(err as Error).message}`);
  }

  return { plugins: customPlugins, pluginMap };
}

// === PLUGIN INSTANTIATION ===
export function createPlugins(
  config: GrafemaConfig['plugins'],
  customPluginMap: Record<string, new () => unknown> = {}
): unknown[] {
  const pluginNames = [
    ...config.indexing,
    ...config.analysis,
    ...config.enrichment,
    ...config.validation,
  ];

  const plugins: unknown[] = [];
  const availablePlugins: Record<string, PluginFactory> = {
    ...BUILTIN_PLUGINS,
    ...Object.fromEntries(
      Object.entries(customPluginMap).map(([name, PluginClass]) => [
        name,
        () => new PluginClass(),
      ])
    ),
  };

  for (const name of pluginNames) {
    const factory = availablePlugins[name];
    if (factory) {
      plugins.push(factory());
      log(`[Grafema MCP] Enabled plugin: ${name}`);
    } else {
      log(`[Grafema MCP] Plugin not found: ${name} (skipping)`);
    }
  }

  return plugins;
}
