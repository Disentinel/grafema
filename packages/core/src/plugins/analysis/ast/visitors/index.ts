/**
 * AST Visitors for JSASTAnalyzer
 *
 * Each visitor handles specific AST node types and extracts relevant data
 * into shared collections.
 */

export { ASTVisitor } from './ASTVisitor.js';
export type {
  VisitorModule,
  VisitorCollections,
  VisitorHandlers,
  VisitorHandler,
  CounterRef,
  ProcessedNodes,
  VariableAssignment,
  LocationInfo
} from './ASTVisitor.js';

export { ImportExportVisitor } from './ImportExportVisitor.js';

export { VariableVisitor } from './VariableVisitor.js';
export type {
  VariableInfo,
  ExtractVariableNamesCallback,
  TrackVariableAssignmentCallback
} from './VariableVisitor.js';

export { FunctionVisitor } from './FunctionVisitor.js';
export type { AnalyzeFunctionBodyCallback } from './FunctionVisitor.js';

export { ClassVisitor } from './ClassVisitor.js';

export { CallExpressionVisitor } from './CallExpressionVisitor.js';

export { TypeScriptVisitor } from './TypeScriptVisitor.js';
