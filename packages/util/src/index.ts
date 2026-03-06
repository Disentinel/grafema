/**
 * @grafema/util - Query, config, and guarantee utilities for Grafema
 *
 * This package contains the live query layer, configuration, diagnostics,
 * and guarantee management. Analysis is handled by grafema-orchestrator (Rust).
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
  StrictModeFailure,
} from './errors/GrafemaError.js';
export type {
  ErrorContext,
  GrafemaErrorJSON,
  ResolutionStep,
  ResolutionFailureReason,
} from './errors/GrafemaError.js';

// Logging
export { ConsoleLogger, FileLogger, MultiLogger, createLogger } from './logging/Logger.js';
export type { Logger, LogLevel } from './logging/Logger.js';

// Diagnostics
export { DiagnosticCollector, DiagnosticReporter, DiagnosticWriter } from './diagnostics/index.js';
export type { Diagnostic, DiagnosticInput, ReportOptions, SummaryStats } from './diagnostics/index.js';
export { DIAGNOSTIC_CATEGORIES, CODE_TO_CATEGORY, getCategoryForCode, getCodesForCategory } from './diagnostics/index.js';
export type { DiagnosticCategory, DiagnosticCategoryKey, CodeCategoryInfo } from './diagnostics/index.js';

// Config
export {
  loadConfig,
  DEFAULT_CONFIG,
  validateVersion,
  validateServices,
  validatePatterns,
  validateWorkspace,
  validateRouting,
} from './config/index.js';
export type { GrafemaConfig } from './config/index.js';

// Version
export { GRAFEMA_VERSION, getSchemaVersion } from './version.js';

// Instructions (for AI agents)
export { getOnboardingInstruction } from './instructions/index.js';

// Graph backend
export { GraphBackend, typeToKind, edgeTypeToNumber } from './core/GraphBackend.js';
export type { Node, Edge, EdgeType, AttrQuery, GraphStats, GraphExport } from './core/GraphBackend.js';

// RFDB
export { RFDBClient } from '@grafema/rfdb-client';
export { RFDBServerBackend } from './storage/backends/RFDBServerBackend.js';

// Core utilities
export {
  computeSemanticId,
  parseSemanticId,
  computeDiscriminator,
  computeSemanticIdV2,
  parseSemanticIdV2,
  computeContentHash
} from './core/SemanticId.js';
export type {
  Location,
  ScopeContext,
  SemanticIdOptions,
  ParsedSemanticId,
  LocatedItem,
  ParsedSemanticIdV2,
  ContentHashHints
} from './core/SemanticId.js';

export { GuaranteeManager } from './core/GuaranteeManager.js';
export type { GuaranteeGraph } from './core/GuaranteeManager.js';

// Hash utilities
export { calculateFileHash, calculateFileHashAsync, calculateContentHash } from './core/HashUtils.js';

// RFDB binary finder utilities
export { findRfdbBinary, getBinaryNotFoundMessage, getPlatformDir } from './utils/findRfdbBinary.js';
export type { FindBinaryOptions } from './utils/findRfdbBinary.js';

// RFDB server lifecycle
export { startRfdbServer, checkExistingServer } from './utils/startRfdbServer.js';
export type { StartRfdbServerOptions } from './utils/startRfdbServer.js';

// Module resolution utilities
export {
  resolveModulePath,
  isRelativeImport,
  resolveRelativeSpecifier,
  DEFAULT_EXTENSIONS,
  DEFAULT_INDEX_FILES
} from './utils/moduleResolution.js';
export type { ModuleResolutionOptions } from './utils/moduleResolution.js';

// Node file path resolution
export { resolveNodeFile } from './utils/resolveNodeFile.js';

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

// Coverage
export { CoverageAnalyzer } from './core/CoverageAnalyzer.js';
export type { CoverageResult } from './core/CoverageAnalyzer.js';

// File analysis utilities
export { FileExplainer } from './core/FileExplainer.js';
export type { FileExplainResult, EnhancedNode } from './core/FileExplainer.js';
export { FileOverview } from './core/FileOverview.js';
export type {
  FileOverviewResult,
  ImportInfo,
  ExportInfo,
  FunctionOverview,
  ClassOverview,
  VariableOverview,
} from './core/FileOverview.js';

// Resource system
export { ResourceRegistryImpl } from './core/ResourceRegistry.js';

// API
export { GraphAPI } from './api/GraphAPI.js';
export { GuaranteeAPI } from './api/GuaranteeAPI.js';
export type { GuaranteeGraphBackend } from './api/GuaranteeAPI.js';

// Node kinds
export { isGuaranteeType, isGrafemaType } from './core/nodes/NodeKind.js';

// Issue nodes (detected problems)
export { IssueNode, type IssueNodeRecord, type IssueSeverity, type IssueType } from './core/nodes/IssueNode.js';

// Guarantee nodes (contract-based)
export { GuaranteeNode } from './core/nodes/GuaranteeNode.js';
export type {
  GuaranteeNodeRecord,
  GuaranteeNodeOptions,
  GuaranteePriority,
  GuaranteeStatus,
  GuaranteeType,
} from './core/nodes/GuaranteeNode.js';

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

// Knowledge Base
export { KnowledgeBase, SemanticAddressResolver, parseSemanticAddress, parseFrontmatter, parseKBNode, serializeKBNode, parseEdgesFile, appendEdge, parseYamlArrayFile, GitIngest, parseGitLog, normalizeAuthors, getChurn, getCoChanges, getOwnership, getArchaeology } from './knowledge/index.js';
export type { ResolverBackend } from './knowledge/index.js';
export type {
  KBNodeType,
  KBLifecycle,
  KBScope,
  KBNodeBase,
  KBDecision,
  KBFact,
  KBSession,
  KBNode,
  KBEdge,
  KBStats,
  KBQueryFilter,
  ParsedSemanticAddress,
  ResolvedAddress,
  DanglingCodeRef,
} from './knowledge/index.js';
export type { RawCommit, FileChange, AuthorEntry, CommitEntry, IngestResult, Meta } from './knowledge/index.js';
export type { ChurnEntry, CoChangeEntry, OwnershipEntry, ArchaeologyEntry } from './knowledge/index.js';

// Graph Query Utilities
export { findCallsInFunction, findContainingFunction, traceValues, aggregateValues, NONDETERMINISTIC_PATTERNS, NONDETERMINISTIC_OBJECTS } from './queries/index.js';
export { buildNodeContext, getNodeDisplayName, formatEdgeMetadata, STRUCTURAL_EDGE_TYPES } from './queries/index.js';
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
  EdgeWithNode,
  EdgeGroup,
  SourcePreview,
  NodeContext,
  BuildNodeContextOptions,
} from './queries/index.js';

// Re-export types for convenience
export type * from '@grafema/types';
