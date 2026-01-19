/**
 * @grafema/core - Core analysis engine for GraphDD
 */

// Main orchestrator
export { Orchestrator } from './Orchestrator.js';
export type {
  OrchestratorOptions,
  ProgressCallback,
  ProgressInfo,
  ParallelConfig,
  ServiceInfo,
  EntrypointInfo,
  DiscoveryManifest,
  IndexingUnit,
} from './Orchestrator.js';

// Plugin base
export { Plugin } from './plugins/Plugin.js';
export type { PluginContext } from './plugins/Plugin.js';

// Graph backend
export { GraphBackend, typeToKind, edgeTypeToNumber } from './core/GraphBackend.js';
export type { Node, Edge, EdgeType, AttrQuery, GraphStats, GraphExport } from './core/GraphBackend.js';

// RFDB
export { RFDBClient } from '@grafema/rfdb-client';
export { RFDBServerBackend } from './storage/backends/RFDBServerBackend.js';

// Core utilities
export { NodeFactory } from './core/NodeFactory.js';
export { Profiler } from './core/Profiler.js';
export { AnalysisQueue } from './core/AnalysisQueue.js';
export { GuaranteeManager } from './core/GuaranteeManager.js';
export type { GuaranteeGraph } from './core/GuaranteeManager.js';

// API
export { GraphAPI } from './api/GraphAPI.js';
export { GuaranteeAPI } from './api/GuaranteeAPI.js';
export type { GuaranteeGraphBackend } from './api/GuaranteeAPI.js';

// Node kinds
export { isGuaranteeType } from './core/nodes/NodeKind.js';

// === PLUGINS ===

// Indexing plugins
export { JSModuleIndexer } from './plugins/indexing/JSModuleIndexer.js';
export { IncrementalModuleIndexer } from './plugins/indexing/IncrementalModuleIndexer.js';
export { RustModuleIndexer } from './plugins/indexing/RustModuleIndexer.js';
export { ServiceDetector } from './plugins/indexing/ServiceDetector.js';

// Analysis plugins
export { JSASTAnalyzer } from './plugins/analysis/JSASTAnalyzer.js';
export { ExpressRouteAnalyzer } from './plugins/analysis/ExpressRouteAnalyzer.js';
export { ExpressAnalyzer } from './plugins/analysis/ExpressAnalyzer.js';
export { SocketIOAnalyzer } from './plugins/analysis/SocketIOAnalyzer.js';
export { DatabaseAnalyzer } from './plugins/analysis/DatabaseAnalyzer.js';
export { FetchAnalyzer } from './plugins/analysis/FetchAnalyzer.js';
export { ServiceLayerAnalyzer } from './plugins/analysis/ServiceLayerAnalyzer.js';
export { ReactAnalyzer } from './plugins/analysis/ReactAnalyzer.js';
export { RustAnalyzer } from './plugins/analysis/RustAnalyzer.js';
export { SQLiteAnalyzer } from './plugins/analysis/SQLiteAnalyzer.js';
export { SystemDbAnalyzer } from './plugins/analysis/SystemDbAnalyzer.js';
export { IncrementalAnalysisPlugin } from './plugins/analysis/IncrementalAnalysisPlugin.js';

// Enrichment plugins
export { MethodCallResolver } from './plugins/enrichment/MethodCallResolver.js';
export { AliasTracker } from './plugins/enrichment/AliasTracker.js';
export { ValueDomainAnalyzer } from './plugins/enrichment/ValueDomainAnalyzer.js';
export { MountPointResolver } from './plugins/enrichment/MountPointResolver.js';
export { PrefixEvaluator } from './plugins/enrichment/PrefixEvaluator.js';
export { InstanceOfResolver } from './plugins/enrichment/InstanceOfResolver.js';
export { HTTPConnectionEnricher } from './plugins/enrichment/HTTPConnectionEnricher.js';
export { ImportExportLinker } from './plugins/enrichment/ImportExportLinker.js';
export { RustFFIEnricher } from './plugins/enrichment/RustFFIEnricher.js';

// Validation plugins
export { CallResolverValidator } from './plugins/validation/CallResolverValidator.js';
export { EvalBanValidator } from './plugins/validation/EvalBanValidator.js';
export { SQLInjectionValidator } from './plugins/validation/SQLInjectionValidator.js';
export { ShadowingDetector } from './plugins/validation/ShadowingDetector.js';
export { GraphConnectivityValidator } from './plugins/validation/GraphConnectivityValidator.js';
export { DataFlowValidator } from './plugins/validation/DataFlowValidator.js';
export { TypeScriptDeadCodeValidator } from './plugins/validation/TypeScriptDeadCodeValidator.js';

// Discovery plugins
export { SimpleProjectDiscovery } from './plugins/discovery/SimpleProjectDiscovery.js';
export { DiscoveryPlugin } from './plugins/discovery/DiscoveryPlugin.js';
export { MonorepoServiceDiscovery } from './plugins/discovery/MonorepoServiceDiscovery.js';

// Re-export types for convenience
export type * from '@grafema/types';
