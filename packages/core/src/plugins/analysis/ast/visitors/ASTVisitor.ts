/**
 * Base class for AST visitors
 * Each visitor handles specific AST node types and collects relevant data
 */
import type { Node, SourceLocation } from '@babel/types';
import { getNodeLocation, type NodeLocation } from '../utils/location.js';
import type { NodePath } from '@babel/traverse';
import type {
  FunctionInfo,
  ClassDeclarationInfo,
  ClassInstantiationInfo,
  ScopeInfo,
  VariableDeclarationInfo,
  CallSiteInfo,
  MethodCallInfo,
  EventListenerInfo,
  MethodCallbackInfo,
  LiteralInfo,
  ImportInfo,
  ExportInfo,
  HttpRequestInfo,
  VariableAssignmentInfo,
  CallArgumentInfo,
  ParameterInfo,
  CounterRef,
  ProcessedNodes
} from '../types.js';

/**
 * Module info passed to visitors
 */
export interface VisitorModule {
  id: string;
  file: string;
  name: string;
  [key: string]: unknown;
}

// Re-export types that were previously defined locally
export type { CounterRef, ProcessedNodes, VariableAssignmentInfo as VariableAssignment };

/**
 * Shared collections populated by visitors
 */
export interface VisitorCollections {
  // Core collections - all optional for partial passing
  functions?: FunctionInfo[];
  classes?: ClassDeclarationInfo[];
  methods?: FunctionInfo[];  // Methods are also FunctionInfo
  imports?: ImportInfo[];
  exports?: ExportInfo[];
  variables?: VariableDeclarationInfo[];
  variableDeclarations?: VariableDeclarationInfo[];  // Alias for variables
  variableAssignments?: VariableAssignmentInfo[];
  callSites?: CallSiteInfo[];
  methodCalls?: MethodCallInfo[];
  eventListeners?: EventListenerInfo[];
  methodCallbacks?: MethodCallbackInfo[];
  classInstantiations?: ClassInstantiationInfo[];
  classDeclarations?: ClassDeclarationInfo[];  // Alias for classes
  literals?: LiteralInfo[];
  callArguments?: CallArgumentInfo[];
  scopes?: ScopeInfo[];
  httpRequests?: HttpRequestInfo[];
  parameters?: ParameterInfo[];
  sideEffects?: unknown[];  // TODO: define SideEffectInfo type
  code?: string;  // Source code for condition extraction

  // Counters - optional
  functionCounterRef?: CounterRef;
  callSiteCounterRef?: CounterRef;
  literalCounterRef?: CounterRef;
  variableCounterRef?: CounterRef;
  scopeCounterRef?: CounterRef;
  ifScopeCounterRef?: CounterRef;
  varDeclCounterRef?: CounterRef;
  httpRequestCounterRef?: CounterRef;
  anonymousFunctionCounterRef?: CounterRef;

  // Deduplication - optional
  processedNodes?: ProcessedNodes;

  // Allow additional collections
  [key: string]: unknown;
}

/**
 * Location info extracted from AST node.
 * Both line and column are guaranteed to be numbers (not undefined).
 * Convention: 0:0 means "unknown location".
 */
export interface LocationInfo {
  line: number;
  column: number;
}

/**
 * Handler function type for Babel traverse
 */
export type VisitorHandler = (path: NodePath) => void;

/**
 * Visitor handlers object
 */
export interface VisitorHandlers {
  [nodeType: string]: VisitorHandler;
}

/**
 * Base class for AST visitors
 */
export abstract class ASTVisitor {
  protected module: VisitorModule;
  protected collections: VisitorCollections;

  /**
   * @param module - Current module being analyzed (file, path etc)
   * @param collections - Shared collections to populate
   */
  constructor(module: VisitorModule, collections: VisitorCollections) {
    this.module = module;
    this.collections = collections;
  }

  /**
   * Returns the Babel traverse visitor handlers
   * @returns Object with AST node type handlers
   */
  abstract getHandlers(): VisitorHandlers;

  /**
   * Utility to get source location info.
   * Returns { line: 0, column: 0 } if location is unavailable.
   *
   * @deprecated Prefer using getLine() or getNodeLocation() directly from utils/location.js
   */
  protected getLoc(node: Node): LocationInfo {
    return getNodeLocation(node);
  }
}
