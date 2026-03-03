/**
 * Built-in plugin registry — maps plugin names to factory functions.
 *
 * Each entry creates a fresh plugin instance. Plugin names match the class names
 * and are referenced by name in .grafema/config.yaml under phases:
 * discovery, indexing, analysis, enrichment, validation.
 */

import type { Plugin } from '@grafema/core';
import {
  // Discovery
  SimpleProjectDiscovery,
  MonorepoServiceDiscovery,
  WorkspaceDiscovery,
  // Indexing
  JSModuleIndexer,
  RustModuleIndexer,
  // Analysis
  CoreV2Analyzer,
  CoreV3Analyzer,
  ExpressRouteAnalyzer,
  ExpressResponseAnalyzer,
  NestJSRouteAnalyzer,
  SocketIOAnalyzer,
  DatabaseAnalyzer,
  FetchAnalyzer,
  ServiceLayerAnalyzer,
  ReactAnalyzer,
  RustAnalyzer,
  // Enrichment
  ValueDomainAnalyzer,
  MountPointResolver,
  ExpressHandlerLinker,
  PrefixEvaluator,
  ExportEntityLinker,
  HTTPConnectionEnricher,
  ConfigRoutingMapBuilder,
  ServiceConnectionEnricher,
  RustFFIEnricher,
  RejectionPropagationEnricher,
  CallbackCallResolver,
  RedisEnricher,
  NodejsBuiltinsResolver,
  PropertyAssignmentResolver,
  // Validation
  CallResolverValidator,
  EvalBanValidator,
  SQLInjectionValidator,
  AwaitInLoopValidator,
  ShadowingDetector,
  GraphConnectivityValidator,
  DataFlowValidator,
  BrokenImportValidator,
  UnconnectedRouteValidator,
  PackageCoverageValidator,
} from '@grafema/core';

export const BUILTIN_PLUGINS: Record<string, () => Plugin> = {
  // Discovery
  SimpleProjectDiscovery: () => new SimpleProjectDiscovery() as Plugin,
  MonorepoServiceDiscovery: () => new MonorepoServiceDiscovery() as Plugin,
  WorkspaceDiscovery: () => new WorkspaceDiscovery() as Plugin,
  // Indexing
  JSModuleIndexer: () => new JSModuleIndexer() as Plugin,
  RustModuleIndexer: () => new RustModuleIndexer() as Plugin,
  // Analysis
  CoreV2Analyzer: () => new CoreV2Analyzer() as Plugin,
  CoreV3Analyzer: () => new CoreV3Analyzer() as Plugin,
  ExpressRouteAnalyzer: () => new ExpressRouteAnalyzer() as Plugin,
  ExpressResponseAnalyzer: () => new ExpressResponseAnalyzer() as Plugin,
  NestJSRouteAnalyzer: () => new NestJSRouteAnalyzer() as Plugin,
  SocketIOAnalyzer: () => new SocketIOAnalyzer() as Plugin,
  DatabaseAnalyzer: () => new DatabaseAnalyzer() as Plugin,
  FetchAnalyzer: () => new FetchAnalyzer() as Plugin,
  ServiceLayerAnalyzer: () => new ServiceLayerAnalyzer() as Plugin,
  ReactAnalyzer: () => new ReactAnalyzer() as Plugin,
  RustAnalyzer: () => new RustAnalyzer() as Plugin,
  // Enrichment
  ValueDomainAnalyzer: () => new ValueDomainAnalyzer() as Plugin,
  MountPointResolver: () => new MountPointResolver() as Plugin,
  ExpressHandlerLinker: () => new ExpressHandlerLinker() as Plugin,
  PrefixEvaluator: () => new PrefixEvaluator() as Plugin,
  ExportEntityLinker: () => new ExportEntityLinker() as Plugin,
  HTTPConnectionEnricher: () => new HTTPConnectionEnricher() as Plugin,
  ConfigRoutingMapBuilder: () => new ConfigRoutingMapBuilder() as Plugin,
  ServiceConnectionEnricher: () => new ServiceConnectionEnricher() as Plugin,
  RustFFIEnricher: () => new RustFFIEnricher() as Plugin,
  RejectionPropagationEnricher: () => new RejectionPropagationEnricher() as Plugin,
  CallbackCallResolver: () => new CallbackCallResolver() as Plugin,
  RedisEnricher: () => new RedisEnricher() as Plugin,
  NodejsBuiltinsResolver: () => new NodejsBuiltinsResolver() as Plugin,
  PropertyAssignmentResolver: () => new PropertyAssignmentResolver() as Plugin,
  // Validation
  CallResolverValidator: () => new CallResolverValidator() as Plugin,
  EvalBanValidator: () => new EvalBanValidator() as Plugin,
  SQLInjectionValidator: () => new SQLInjectionValidator() as Plugin,
  AwaitInLoopValidator: () => new AwaitInLoopValidator() as Plugin,
  ShadowingDetector: () => new ShadowingDetector() as Plugin,
  GraphConnectivityValidator: () => new GraphConnectivityValidator() as Plugin,
  DataFlowValidator: () => new DataFlowValidator() as Plugin,
  BrokenImportValidator: () => new BrokenImportValidator() as Plugin,
  UnconnectedRouteValidator: () => new UnconnectedRouteValidator() as Plugin,
  PackageCoverageValidator: () => new PackageCoverageValidator() as Plugin,
};
