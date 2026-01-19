/**
 * MCP Server Configuration
 */

import { join } from 'path';
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { pathToFileURL } from 'url';
import { log } from './utils.js';
import type { GrafemaConfig } from './types.js';

// === PLUGIN IMPORTS ===
import {
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

// === DEFAULT CONFIG ===
export interface PluginConfig {
  indexing: string[];
  analysis: string[];
  enrichment: string[];
  validation: string[];
  discovery?: string[];
}

export interface ProjectConfig {
  plugins: PluginConfig;
  discovery: {
    enabled: boolean;
    customOnly: boolean;
  };
  analysis?: {
    service?: string;
  };
  backend?: 'local' | 'rfdb';
  rfdb_socket?: string;
}

export const DEFAULT_CONFIG: ProjectConfig = {
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
  SocketIOAnalyzer: () => new SocketIOAnalyzer(),
  DatabaseAnalyzer: () => new DatabaseAnalyzer(),
  FetchAnalyzer: () => new FetchAnalyzer(),
  ServiceLayerAnalyzer: () => new ServiceLayerAnalyzer(),
  ReactAnalyzer: () => new ReactAnalyzer(),
  RustAnalyzer: () => new RustAnalyzer(),

  // Enrichment
  MethodCallResolver: () => new MethodCallResolver(),
  AliasTracker: () => new AliasTracker(),
  ValueDomainAnalyzer: () => new ValueDomainAnalyzer(),
  MountPointResolver: () => new MountPointResolver(),
  PrefixEvaluator: () => new PrefixEvaluator(),
  InstanceOfResolver: () => new InstanceOfResolver(),
  HTTPConnectionEnricher: () => new HTTPConnectionEnricher(),
  RustFFIEnricher: () => new RustFFIEnricher(),

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
export function loadConfig(projectPath: string): ProjectConfig {
  const configPath = join(projectPath, '.grafema', 'config.json');

  if (!existsSync(configPath)) {
    try {
      const grafemaDir = join(projectPath, '.grafema');
      if (!existsSync(grafemaDir)) {
        const { mkdirSync } = require('fs');
        mkdirSync(grafemaDir, { recursive: true });
      }
      writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2));
      log(`[Grafema MCP] Created default config: ${configPath}`);
    } catch (err) {
      log(`[Grafema MCP] Failed to create config: ${(err as Error).message}`);
    }
    return DEFAULT_CONFIG;
  }

  try {
    const configContent = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(configContent) as Partial<ProjectConfig>;
    log(`[Grafema MCP] Loaded config from ${configPath}`);
    return { ...DEFAULT_CONFIG, ...config };
  } catch (err) {
    log(`[Grafema MCP] Failed to load config: ${(err as Error).message}, using defaults`);
    return DEFAULT_CONFIG;
  }
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
  pluginNames: string[],
  customPluginMap: Record<string, new () => unknown> = {}
): unknown[] {
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
      log(`[Grafema MCP] Warning: Unknown plugin ${name}`);
    }
  }

  return plugins;
}
