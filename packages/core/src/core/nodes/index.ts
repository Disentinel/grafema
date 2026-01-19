/**
 * Node Types - export all node types and their contracts
 */

// Core nodes
export { ServiceNode, type ServiceNodeRecord } from './ServiceNode.js';
export { EntrypointNode, type EntrypointNodeRecord, type EntrypointType, type EntrypointTrigger, type EntrypointSource, ENTRYPOINT_TYPES, ENTRYPOINT_TRIGGERS, ENTRYPOINT_SOURCES } from './EntrypointNode.js';
export { ModuleNode, type ModuleNodeRecord } from './ModuleNode.js';
export { FunctionNode } from './FunctionNode.js';
export { ClassNode, type ClassNodeRecord } from './ClassNode.js';
export { MethodNode, type MethodNodeRecord, type MethodKind } from './MethodNode.js';
export { ParameterNode, type ParameterNodeRecord } from './ParameterNode.js';
export { ScopeNode, type ScopeNodeRecord } from './ScopeNode.js';

// Call/reference nodes
export { CallSiteNode, type CallSiteNodeRecord } from './CallSiteNode.js';
export { MethodCallNode, type MethodCallNodeRecord } from './MethodCallNode.js';
export { VariableDeclarationNode, type VariableDeclarationNodeRecord } from './VariableDeclarationNode.js';
export { ConstantNode, type ConstantNodeRecord } from './ConstantNode.js';
export { LiteralNode, type LiteralNodeRecord } from './LiteralNode.js';

// Import/Export nodes
export { ImportNode, type ImportNodeRecord, type ImportKind } from './ImportNode.js';
export { ExportNode, type ExportNodeRecord, type ExportKind } from './ExportNode.js';

// External/IO nodes
export { ExternalStdioNode, type ExternalStdioNodeRecord } from './ExternalStdioNode.js';
export { EventListenerNode, type EventListenerNodeRecord } from './EventListenerNode.js';
export { HttpRequestNode, type HttpRequestNodeRecord } from './HttpRequestNode.js';
export { DatabaseQueryNode, type DatabaseQueryNodeRecord } from './DatabaseQueryNode.js';

// Guarantee nodes (contract-based)
export { GuaranteeNode, type GuaranteeNodeRecord, type GuaranteePriority, type GuaranteeStatus, type GuaranteeType } from './GuaranteeNode.js';

// Node type constants and helpers
export {
  NODE_TYPE,
  NAMESPACED_TYPE,
  isNamespacedType,
  getNamespace,
  getBaseName,
  isEndpointType,
  isSideEffectType,
  matchesTypePattern,
  isGuaranteeType,
  type BaseNodeType,
  type NamespacedNodeType,
  type NodeType,
} from './NodeKind.js';
