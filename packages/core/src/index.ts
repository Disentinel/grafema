/**
 * @grafema/core - Core analysis engine for GraphDD
 */

// Error types
export {
  GrafemaError,
  ConfigError,
  FileAccessError,
  LanguageError,
  DatabaseError,
  PluginError,
  AnalysisError,
  ValidationError,
  StrictModeError,
} from './errors/GrafemaError.js';
export type { ErrorContext, GrafemaErrorJSON } from './errors/GrafemaError.js';

// Logging
export { Logger, ConsoleLogger, createLogger } from './logging/Logger.js';
export type { LogLevel } from './logging/Logger.js';

// Diagnostics
export { DiagnosticCollector, DiagnosticReporter, DiagnosticWriter } from './diagnostics/index.js';
export type { Diagnostic, DiagnosticInput, ReportOptions, SummaryStats } from './diagnostics/index.js';

// Config
export { loadConfig, DEFAULT_CONFIG } from './config/index.js';
export type { GrafemaConfig } from './config/index.js';

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
export {
  computeSemanticId,
  parseSemanticId,
  computeDiscriminator
} from './core/SemanticId.js';
export type {
  Location,
  ScopeContext,
  SemanticIdOptions,
  ParsedSemanticId,
  LocatedItem
} from './core/SemanticId.js';
export { ScopeTracker } from './core/ScopeTracker.js';
export type { ScopeEntry, CountedScopeResult } from './core/ScopeTracker.js';
export { AnalysisQueue } from './core/AnalysisQueue.js';
export { ASTWorkerPool, type ModuleInfo as ASTModuleInfo, type ParseResult, type ASTWorkerPoolStats } from './core/ASTWorkerPool.js';
export { GuaranteeManager } from './core/GuaranteeManager.js';
export type { GuaranteeGraph } from './core/GuaranteeManager.js';
export { clearFileNodesIfNeeded, clearServiceNodeIfExists } from './core/FileNodeManager.js';
export { CoverageAnalyzer } from './core/CoverageAnalyzer.js';
export type { CoverageResult } from './core/CoverageAnalyzer.js';
export { FileExplainer } from './core/FileExplainer.js';
export type { FileExplainResult, EnhancedNode } from './core/FileExplainer.js';

// Hash utilities
export { calculateFileHash, calculateFileHashAsync, calculateContentHash } from './core/HashUtils.js';

// Type validation and path validation
export {
  levenshtein,
  checkTypoAgainstKnownTypes,
  resetKnownNodeTypes,
  getKnownNodeTypes
} from './storage/backends/typeValidation.js';
export { PathValidator } from './validation/PathValidator.js';
export type { PathValidationResult, EndpointDiff } from './validation/PathValidator.js';

// Version management
export { VersionManager, versionManager } from './core/VersionManager.js';
export type { VersionedNode, VersionConstants, EnrichOptions, ModifiedNodeInfo, ChangesSummary, ClassifyChangesResult } from './core/VersionManager.js';

// Freshness checking and incremental reanalysis
export { GraphFreshnessChecker } from './core/GraphFreshnessChecker.js';
export type { FreshnessGraph, FreshnessResult, StaleModule } from './core/GraphFreshnessChecker.js';
export { IncrementalReanalyzer } from './core/IncrementalReanalyzer.js';
export type { ReanalysisOptions, ReanalysisProgress, ReanalysisResult } from './core/IncrementalReanalyzer.js';

// API
export { GraphAPI } from './api/GraphAPI.js';
export { GuaranteeAPI } from './api/GuaranteeAPI.js';
export type { GuaranteeGraphBackend } from './api/GuaranteeAPI.js';

// Node kinds
export { isGuaranteeType } from './core/nodes/NodeKind.js';

// Issue nodes (detected problems)
export { IssueNode, type IssueNodeRecord, type IssueSeverity, type IssueType } from './core/nodes/IssueNode.js';

// Node contracts
export { FunctionNode } from './core/nodes/FunctionNode.js';
export { CallSiteNode } from './core/nodes/CallSiteNode.js';
export { MethodCallNode } from './core/nodes/MethodCallNode.js';
export { ScopeNode } from './core/nodes/ScopeNode.js';
export { ClassNode } from './core/nodes/ClassNode.js';
export { MethodNode } from './core/nodes/MethodNode.js';
export { ExportNode } from './core/nodes/ExportNode.js';
export { VariableDeclarationNode } from './core/nodes/VariableDeclarationNode.js';
export { ExternalModuleNode } from './core/nodes/ExternalModuleNode.js';
export { NetworkRequestNode } from './core/nodes/NetworkRequestNode.js';
export { InterfaceNode, type InterfacePropertyRecord } from './core/nodes/InterfaceNode.js';
export { TypeNode } from './core/nodes/TypeNode.js';
export { EnumNode, type EnumMemberRecord } from './core/nodes/EnumNode.js';
export { DecoratorNode, type DecoratorTargetType } from './core/nodes/DecoratorNode.js';
export { ExpressionNode, type ExpressionNodeOptions } from './core/nodes/ExpressionNode.js';
export { ArgumentExpressionNode, type ArgumentExpressionNodeRecord, type ArgumentExpressionNodeOptions } from './core/nodes/ArgumentExpressionNode.js';

// AST Visitors (for advanced usage)
export {
  ASTVisitor,
  ImportExportVisitor,
  VariableVisitor,
  FunctionVisitor,
  ClassVisitor,
  CallExpressionVisitor,
  TypeScriptVisitor
} from './plugins/analysis/ast/visitors/index.js';
export type {
  VisitorModule,
  VisitorCollections,
  VisitorHandlers,
  VisitorHandler,
  VariableInfo,
  ExtractVariableNamesCallback,
  TrackVariableAssignmentCallback,
  AnalyzeFunctionBodyCallback
} from './plugins/analysis/ast/visitors/index.js';

// AST Location utilities (REG-122)
export {
  getNodeLocation,
  getLine,
  getColumn,
  getEndLocation,
  UNKNOWN_LOCATION
} from './plugins/analysis/ast/utils/location.js';
export type { NodeLocation } from './plugins/analysis/ast/utils/location.js';

// === PLUGINS ===

// Indexing plugins
export { JSModuleIndexer } from './plugins/indexing/JSModuleIndexer.js';
export { IncrementalModuleIndexer } from './plugins/indexing/IncrementalModuleIndexer.js';
export { RustModuleIndexer } from './plugins/indexing/RustModuleIndexer.js';

// Analysis plugins
export { JSASTAnalyzer } from './plugins/analysis/JSASTAnalyzer.js';
export { ExpressRouteAnalyzer } from './plugins/analysis/ExpressRouteAnalyzer.js';
export { ExpressResponseAnalyzer } from './plugins/analysis/ExpressResponseAnalyzer.js';
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
export { MethodCallResolver, LIBRARY_SEMANTIC_GROUPS } from './plugins/enrichment/MethodCallResolver.js';
export type { LibraryCallStats } from './plugins/enrichment/MethodCallResolver.js';
export { ArgumentParameterLinker } from './plugins/enrichment/ArgumentParameterLinker.js';
export { AliasTracker } from './plugins/enrichment/AliasTracker.js';
export { ValueDomainAnalyzer } from './plugins/enrichment/ValueDomainAnalyzer.js';
export { MountPointResolver } from './plugins/enrichment/MountPointResolver.js';
export { PrefixEvaluator } from './plugins/enrichment/PrefixEvaluator.js';
export { InstanceOfResolver } from './plugins/enrichment/InstanceOfResolver.js';
export { HTTPConnectionEnricher } from './plugins/enrichment/HTTPConnectionEnricher.js';
export { ImportExportLinker } from './plugins/enrichment/ImportExportLinker.js';
export { FunctionCallResolver } from './plugins/enrichment/FunctionCallResolver.js';
export { RustFFIEnricher } from './plugins/enrichment/RustFFIEnricher.js';
export { NodejsBuiltinsResolver } from './plugins/enrichment/NodejsBuiltinsResolver.js';
export { ExternalCallResolver } from './plugins/enrichment/ExternalCallResolver.js';
export { ClosureCaptureEnricher } from './plugins/enrichment/ClosureCaptureEnricher.js';

// Builtin registry
export { BuiltinRegistry } from './data/builtins/index.js';
export type { BuiltinFunctionDef, BuiltinModuleDef, SecurityCategory } from './data/builtins/index.js';

// Globals registry
export { GlobalsRegistry, ALL_GLOBALS } from './data/globals/index.js';

// Validation plugins
export { CallResolverValidator } from './plugins/validation/CallResolverValidator.js';
export { EvalBanValidator } from './plugins/validation/EvalBanValidator.js';
export { SQLInjectionValidator } from './plugins/validation/SQLInjectionValidator.js';
export { ShadowingDetector } from './plugins/validation/ShadowingDetector.js';
export { GraphConnectivityValidator } from './plugins/validation/GraphConnectivityValidator.js';
export { DataFlowValidator } from './plugins/validation/DataFlowValidator.js';
export { TypeScriptDeadCodeValidator } from './plugins/validation/TypeScriptDeadCodeValidator.js';
export { NodeCreationValidator } from './plugins/validation/NodeCreationValidator.js';
export { BrokenImportValidator } from './plugins/validation/BrokenImportValidator.js';

// Discovery plugins
export { SimpleProjectDiscovery } from './plugins/discovery/SimpleProjectDiscovery.js';
export { DiscoveryPlugin } from './plugins/discovery/DiscoveryPlugin.js';
export { MonorepoServiceDiscovery } from './plugins/discovery/MonorepoServiceDiscovery.js';
export { WorkspaceDiscovery } from './plugins/discovery/WorkspaceDiscovery.js';
export { resolveSourceEntrypoint } from './plugins/discovery/resolveSourceEntrypoint.js';
export type { PackageJsonForResolution } from './plugins/discovery/resolveSourceEntrypoint.js';

// Workspace detection utilities
export {
  detectWorkspaceType,
  parsePnpmWorkspace,
  parseNpmWorkspace,
  parseLernaConfig,
  resolveWorkspacePackages
} from './plugins/discovery/workspaces/index.js';
export type {
  WorkspaceType,
  WorkspaceDetectionResult,
  WorkspaceConfig,
  WorkspacePackage
} from './plugins/discovery/workspaces/index.js';

// VCS plugins
export { GitPlugin } from './plugins/vcs/GitPlugin.js';
export { VCSPlugin, VCSPluginFactory, FileStatus } from './plugins/vcs/VCSPlugin.js';
export type {
  VCSConfig,
  VCSPluginMetadata,
  ChangedFile,
  FileDiff,
  DiffHunk,
} from './plugins/vcs/VCSPlugin.js';
export type { CommitInfo } from './plugins/vcs/GitPlugin.js';

// Schema extraction
export { InterfaceSchemaExtractor, GraphSchemaExtractor } from './schema/index.js';
export type {
  InterfaceSchema,
  PropertySchema,
  ExtractOptions,
  GraphSchema,
  NodeTypeSchema,
  EdgeTypeSchema,
  GraphExtractOptions,
} from './schema/index.js';

// Graph Query Utilities
export { findCallsInFunction, findContainingFunction, traceValues, aggregateValues, NONDETERMINISTIC_PATTERNS, NONDETERMINISTIC_OBJECTS } from './queries/index.js';
export type {
  CallInfo,
  CallerInfo,
  FindCallsOptions,
  TracedValue,
  ValueSource,
  UnknownReason,
  TraceValuesOptions,
  ValueSetResult,
  TraceValuesGraphBackend,
  NondeterministicPattern,
} from './queries/index.js';

// Re-export types for convenience
export type * from '@grafema/types';
