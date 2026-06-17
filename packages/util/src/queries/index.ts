/**
 * Graph Query Utilities
 *
 * Shared utilities for querying the code graph.
 * Used by MCP, CLI, and other tools.
 *
 * @module queries
 */

export { findCallsInFunction } from './findCallsInFunction.js';
export { findContainingFunction } from './findContainingFunction.js';
export { traceValues, aggregateValues, NONDETERMINISTIC_PATTERNS, NONDETERMINISTIC_OBJECTS } from './traceValues.js';
export { traceDataflow, traceForwardBFS, traceBackwardBFS, makeDataflowIndexCache } from './traceDataflow.js';
export { traceCallChain } from './traceCallChain.js';
export { getShape } from './getShape.js';
export type { ShapeResult, ShapeMember, ClassIndex } from './getShape.js';
export {
  buildNodeContext,
  getNodeDisplayName,
  formatEdgeMetadata,
  STRUCTURAL_EDGE_TYPES,
} from './NodeContext.js';

export type { CallInfo, CallerInfo, FindCallsOptions } from './types.js';
export type {
  EdgeWithNode,
  EdgeGroup,
  SourcePreview,
  NodeContext,
  BuildNodeContextOptions,
} from './NodeContext.js';
export type {
  TracedValue,
  ValueSource,
  UnknownReason,
  TraceValuesOptions,
  ValueSetResult,
  TraceValuesGraphBackend,
  NondeterministicPattern,
} from './types.js';
export type {
  DataflowNode,
  DataflowEdge,
  DataflowBackend,
  TraceDataflowOptions,
  TraceDataflowResult,
  DataflowIndexCache,
} from './traceDataflow.js';
export { traceEffects } from './traceEffects.js';
export type { TraceEffectsResult, BoundaryCrossing, LeafSource, TraceEffectsOptions, UnsoundResolutionLeaf } from './traceEffects.js';
export {
  classifyResolution,
  auditResolutionPrecision,
  receiverExternalImport,
  soundnessOf,
  checkResolutionSoundness,
} from './resolutionPrecision.js';
export type {
  ResolutionPrecision,
  ResolutionMarker,
  ResolutionBasis,
  ClassifyContext,
  MarkedResolution,
  UnsoundCase,
  ResolutionPrecisionAudit,
  SoundnessVerdict,
  ResolutionSoundnessViolation,
  ResolutionSoundnessReport,
} from './resolutionPrecision.js';
