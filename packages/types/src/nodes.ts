/**
 * Node Types - graph node type definitions
 */

// === BASE NODE TYPES ===
export const NODE_TYPE = {
  // Core code entities
  FUNCTION: 'FUNCTION',
  CLASS: 'CLASS',
  METHOD: 'METHOD',
  VARIABLE: 'VARIABLE',
  PARAMETER: 'PARAMETER',
  CONSTANT: 'CONSTANT',
  LITERAL: 'LITERAL',
  EXPRESSION: 'EXPRESSION',

  // Module system
  MODULE: 'MODULE',
  IMPORT: 'IMPORT',
  EXPORT: 'EXPORT',

  // Call graph
  CALL: 'CALL',
  PROPERTY_ACCESS: 'PROPERTY_ACCESS',

  // Project structure
  PROJECT: 'PROJECT',
  SERVICE: 'SERVICE',
  FILE: 'FILE',
  SCOPE: 'SCOPE',

  // Branching
  BRANCH: 'BRANCH',
  CASE: 'CASE',

  // Control flow
  LOOP: 'LOOP',
  TRY_BLOCK: 'TRY_BLOCK',
  CATCH_BLOCK: 'CATCH_BLOCK',
  FINALLY_BLOCK: 'FINALLY_BLOCK',

  // External dependencies
  EXTERNAL: 'EXTERNAL',
  EXTERNAL_MODULE: 'EXTERNAL_MODULE',

  // Generic side effects
  SIDE_EFFECT: 'SIDE_EFFECT',
} as const;

export type BaseNodeType = typeof NODE_TYPE[keyof typeof NODE_TYPE];

// === NAMESPACED NODE TYPES ===
export const NAMESPACED_TYPE = {
  // HTTP (generic)
  HTTP_ROUTE: 'http:route',
  HTTP_REQUEST: 'http:request',

  // Express.js
  EXPRESS_ROUTER: 'express:router',
  EXPRESS_MIDDLEWARE: 'express:middleware',
  EXPRESS_MOUNT: 'express:mount',

  // Socket.IO
  SOCKETIO_EMIT: 'socketio:emit',
  SOCKETIO_ON: 'socketio:on',
  SOCKETIO_NAMESPACE: 'socketio:namespace',

  // Database
  DB_QUERY: 'db:query',
  DB_CONNECTION: 'db:connection',

  // Filesystem
  FS_READ: 'fs:read',
  FS_WRITE: 'fs:write',
  FS_OPERATION: 'fs:operation',

  // Network
  NET_REQUEST: 'net:request',
  NET_STDIO: 'net:stdio',

  // Events
  EVENT_LISTENER: 'event:listener',
  EVENT_EMIT: 'event:emit',

  // Grafema internal (self-describing pipeline)
  GRAFEMA_PLUGIN: 'grafema:plugin',
} as const;

export type NamespacedNodeType = typeof NAMESPACED_TYPE[keyof typeof NAMESPACED_TYPE];

// Combined node type
export type NodeType = BaseNodeType | NamespacedNodeType | string;

// === NODE RECORD ===
// Base interface for all nodes
export interface BaseNodeRecord {
  id: string;
  type: NodeType;
  name?: string;  // Optional - some nodes (BRANCH, CASE, LOOP) don't have meaningful names
  file?: string;  // Optional - some synthetic nodes may not have a file
  exported?: boolean;  // Optional - some nodes may not have export status
  line?: number;  // Optional - not always available
  column?: number;
  metadata?: Record<string, unknown>;
  // Allow arbitrary additional properties for flexibility
  [key: string]: unknown;
}

// Function node
export interface FunctionNodeRecord extends BaseNodeRecord {
  type: 'FUNCTION';
  async: boolean;
  generator: boolean;
  exported: boolean;
  arrowFunction: boolean;
  parentScopeId?: string;
  isClassMethod?: boolean;
  className?: string;
  params?: string[];
  paramTypes?: string[];     // Types for each param
  returnType?: string;       // Return type
  signature?: string;        // Full signature: "(a: T) => R"
  jsdocSummary?: string;     // First line of JSDoc
  start?: number;            // Byte offset in file (for positional linking)
}

// Class node
export interface ClassNodeRecord extends BaseNodeRecord {
  type: 'CLASS';
  exported: boolean;
  superClass?: string;
}

// Method node
export interface MethodNodeRecord extends BaseNodeRecord {
  type: 'METHOD';
  className: string;
  async: boolean;
  static: boolean;
  kind: 'method' | 'get' | 'set' | 'constructor';
}

// Module node
export interface ModuleNodeRecord extends BaseNodeRecord {
  type: 'MODULE';
  relativePath: string;
  contentHash: string;
  language?: string;
}

// Import node
export interface ImportNodeRecord extends BaseNodeRecord {
  type: 'IMPORT';
  source: string;
  specifiers: ImportSpecifier[];
  isDefault?: boolean;
  isNamespace?: boolean;
}

export interface ImportSpecifier {
  local: string;
  imported?: string;
  type: 'default' | 'named' | 'namespace';
}

// Export node
export interface ExportNodeRecord extends BaseNodeRecord {
  type: 'EXPORT';
  exportedName: string;
  localName?: string;
  isDefault?: boolean;
  source?: string;
}

// Variable declaration node
export interface VariableNodeRecord extends BaseNodeRecord {
  type: 'VARIABLE';
  kind: 'var' | 'let' | 'const';
  exported: boolean;
}

// Call node (unified call site)
export interface CallNodeRecord extends BaseNodeRecord {
  type: 'CALL';
  callee: string;
  arguments?: number;
  isMethodCall?: boolean;
  objectName?: string;
}

// Property access node (property read: obj.prop, a.b.c)
export interface PropertyAccessNodeRecord extends BaseNodeRecord {
  type: 'PROPERTY_ACCESS';
  objectName: string;
  optional?: boolean;
  computed?: boolean;
}

// Service node (project-level)
export interface ServiceNodeRecord extends BaseNodeRecord {
  type: 'SERVICE';
  projectPath: string;
}

// Scope node
export interface ScopeNodeRecord extends BaseNodeRecord {
  type: 'SCOPE';
  scopeType: 'function' | 'block' | 'class' | 'module' | 'global';
  parentScopeId?: string;
}

// Branch node (switch, future: if/ternary)
export interface BranchNodeRecord extends BaseNodeRecord {
  type: 'BRANCH';
  branchType: 'switch' | 'if' | 'ternary';  // For future expansion
  parentScopeId?: string;
}

// Case node (switch case clause)
export interface CaseNodeRecord extends BaseNodeRecord {
  type: 'CASE';
  value: unknown;         // Case test value ('ADD', 1, etc.) or null for default
  isDefault: boolean;     // true for default case
  fallsThrough: boolean;  // true if no break/return
  isEmpty: boolean;       // true if case has no statements (intentional fall-through)
}

// Loop node (for, for-in, for-of, while, do-while)
export interface LoopNodeRecord extends BaseNodeRecord {
  type: 'LOOP';
  loopType: 'for' | 'for-in' | 'for-of' | 'while' | 'do-while';
  parentScopeId?: string;
  bodyScopeId?: string;  // ID of SCOPE node containing loop body
  async?: boolean;       // true for for-await-of loops
}

// Try block node
export interface TryBlockNodeRecord extends BaseNodeRecord {
  type: 'TRY_BLOCK';
  parentScopeId?: string;
  bodyScopeId?: string;  // ID of SCOPE node containing try body
}

// Catch block node
export interface CatchBlockNodeRecord extends BaseNodeRecord {
  type: 'CATCH_BLOCK';
  parentScopeId?: string;
  parameterName?: string;  // Error parameter name (e.g., 'e' in catch(e))
  bodyScopeId?: string;    // ID of SCOPE node containing catch body
}

// Finally block node
export interface FinallyBlockNodeRecord extends BaseNodeRecord {
  type: 'FINALLY_BLOCK';
  parentScopeId?: string;
  bodyScopeId?: string;  // ID of SCOPE node containing finally body
}

// HTTP Route node
export interface HttpRouteNodeRecord extends BaseNodeRecord {
  type: 'http:route';
  method: string;
  path: string;
  handler?: string;
}

// Database query node
export interface DbQueryNodeRecord extends BaseNodeRecord {
  type: 'db:query';
  query: string;
  operation: 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'UNKNOWN';
}

// Event listener node
export interface EventListenerNodeRecord extends BaseNodeRecord {
  type: 'event:listener';
  eventName: string;
  objectName: string;
}

// Guarantee priority levels
export type GuaranteePriority = 'critical' | 'important' | 'observed' | 'tracked';

// Guarantee lifecycle status
export type GuaranteeStatus = 'discovered' | 'reviewed' | 'active' | 'changing' | 'deprecated';

// Guarantee node (contract-based)
export interface GuaranteeNodeRecord extends BaseNodeRecord {
  type: 'guarantee:queue' | 'guarantee:api' | 'guarantee:permission';
  priority: GuaranteePriority;
  status: GuaranteeStatus;
  owner?: string;
  schema?: Record<string, unknown>;
  condition?: string;
  description?: string;
  createdAt?: number;
  updatedAt?: number;
}

// Plugin node (Grafema internal - self-describing pipeline)
export interface PluginNodeRecord extends BaseNodeRecord {
  type: 'grafema:plugin';
  phase: string;
  priority: number;
  builtin: boolean;
  createsNodes: string[];
  createsEdges: string[];
  dependencies: string[];
}

// Union of all node types
export type NodeRecord =
  | FunctionNodeRecord
  | ClassNodeRecord
  | MethodNodeRecord
  | ModuleNodeRecord
  | ImportNodeRecord
  | ExportNodeRecord
  | VariableNodeRecord
  | CallNodeRecord
  | PropertyAccessNodeRecord
  | ServiceNodeRecord
  | ScopeNodeRecord
  | BranchNodeRecord
  | CaseNodeRecord
  | LoopNodeRecord
  | TryBlockNodeRecord
  | CatchBlockNodeRecord
  | FinallyBlockNodeRecord
  | HttpRouteNodeRecord
  | DbQueryNodeRecord
  | EventListenerNodeRecord
  | GuaranteeNodeRecord
  | PluginNodeRecord
  | BaseNodeRecord; // fallback for custom types

// === HELPER FUNCTIONS ===
export function isNamespacedType(nodeType: string): boolean {
  return nodeType?.includes(':') ?? false;
}

export function getNamespace(nodeType: string): string | null {
  if (!nodeType?.includes(':')) return null;
  return nodeType.split(':')[0];
}

export function getBaseName(nodeType: string): string {
  if (!nodeType) return '';
  if (!nodeType.includes(':')) return nodeType;
  return nodeType.split(':').slice(1).join(':');
}

export function isEndpointType(nodeType: string): boolean {
  const ns = getNamespace(nodeType);
  return ns === 'http' || ns === 'express' || ns === 'socketio';
}

export function isSideEffectType(nodeType: string): boolean {
  if (nodeType === NODE_TYPE.SIDE_EFFECT) return true;
  const ns = getNamespace(nodeType);
  return ns === 'db' || ns === 'fs' || ns === 'net';
}
