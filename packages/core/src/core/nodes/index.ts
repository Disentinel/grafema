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
export { BranchNode, type BranchNodeRecord } from './BranchNode.js';
export { CaseNode, type CaseNodeRecord } from './CaseNode.js';

// Call/reference nodes
export { CallSiteNode, type CallSiteNodeRecord } from './CallSiteNode.js';
export { MethodCallNode, type MethodCallNodeRecord } from './MethodCallNode.js';
export { ConstructorCallNode, type ConstructorCallNodeRecord } from './ConstructorCallNode.js';
export { VariableDeclarationNode, type VariableDeclarationNodeRecord } from './VariableDeclarationNode.js';
export { ConstantNode, type ConstantNodeRecord } from './ConstantNode.js';
export { LiteralNode, type LiteralNodeRecord } from './LiteralNode.js';
export { ObjectLiteralNode, type ObjectLiteralNodeRecord, type ObjectLiteralNodeOptions } from './ObjectLiteralNode.js';
export { ArrayLiteralNode, type ArrayLiteralNodeRecord, type ArrayLiteralNodeOptions } from './ArrayLiteralNode.js';

// Import/Export nodes
export { ImportNode, type ImportNodeRecord, type ImportBinding, type ImportType } from './ImportNode.js';
export { ExportNode, type ExportNodeRecord, type ExportKind } from './ExportNode.js';
export { ExternalModuleNode, type ExternalModuleNodeRecord } from './ExternalModuleNode.js';

// TypeScript declaration nodes
export { InterfaceNode, type InterfaceNodeRecord, type InterfacePropertyRecord } from './InterfaceNode.js';
export { TypeNode, type TypeNodeRecord } from './TypeNode.js';
export { TypeParameterNode, type TypeParameterNodeRecord, type TypeParameterNodeOptions } from './TypeParameterNode.js';
export { EnumNode, type EnumNodeRecord, type EnumMemberRecord } from './EnumNode.js';
export { DecoratorNode, type DecoratorNodeRecord, type DecoratorTargetType } from './DecoratorNode.js';

// Expression nodes
export { ExpressionNode, type ExpressionNodeRecord, type ExpressionNodeOptions } from './ExpressionNode.js';
export { ArgumentExpressionNode, type ArgumentExpressionNodeRecord, type ArgumentExpressionNodeOptions } from './ArgumentExpressionNode.js';

// External/IO nodes
export { ExternalStdioNode, type ExternalStdioNodeRecord } from './ExternalStdioNode.js';
export { NetworkRequestNode, type NetworkRequestNodeRecord } from './NetworkRequestNode.js';
export { EventListenerNode, type EventListenerNodeRecord } from './EventListenerNode.js';
export { HttpRequestNode, type HttpRequestNodeRecord } from './HttpRequestNode.js';
export { DatabaseQueryNode, type DatabaseQueryNodeRecord } from './DatabaseQueryNode.js';

// HTTP/Express namespaced nodes
export { HttpRouteNode, type HttpRouteNodeRecord, type HttpRouteNodeOptions } from './HttpRouteNode.js';
export { FetchRequestNode, type FetchRequestNodeRecord, type FetchRequestNodeOptions } from './FetchRequestNode.js';
export { ExpressMountNode, type ExpressMountNodeRecord, type ExpressMountNodeOptions } from './ExpressMountNode.js';
export { ExpressMiddlewareNode, type ExpressMiddlewareNodeRecord, type ExpressMiddlewareNodeOptions } from './ExpressMiddlewareNode.js';
export { ExternalApiNode, type ExternalApiNodeRecord } from './ExternalApiNode.js';

// Rust nodes
export { RustModuleNode, type RustModuleNodeRecord } from './RustModuleNode.js';
export { RustFunctionNode, type RustFunctionNodeRecord } from './RustFunctionNode.js';
export { RustStructNode, type RustStructNodeRecord } from './RustStructNode.js';
export { RustImplNode, type RustImplNodeRecord } from './RustImplNode.js';
export { RustMethodNode, type RustMethodNodeRecord } from './RustMethodNode.js';
export { RustTraitNode, type RustTraitNodeRecord, type RustTraitMethodRecord } from './RustTraitNode.js';
export { RustCallNode, type RustCallNodeRecord, type RustCallType } from './RustCallNode.js';

// React domain nodes (react:*, dom:*, browser:*, canvas:*)
export { ReactNode, type ReactNodeRecord } from './ReactNode.js';

// Socket.IO domain nodes (socketio:*)
export {
  SocketIONode,
  type SocketIOEmitNodeRecord,
  type SocketIOListenerNodeRecord,
  type SocketIORoomNodeRecord,
  type SocketIOEventNodeRecord,
} from './SocketIONode.js';

// Socket domain nodes (os:unix-*, net:tcp-*)
export {
  SocketNode as SocketConnectionNode,
  type UnixSocketNodeRecord,
  type TcpConnectionNodeRecord,
  type UnixServerNodeRecord,
  type TcpServerNodeRecord,
  type AnySocketNodeRecord,
} from './SocketNode.js';

// Guarantee nodes (contract-based)
export { GuaranteeNode, type GuaranteeNodeRecord, type GuaranteePriority, type GuaranteeStatus, type GuaranteeType } from './GuaranteeNode.js';

// Issue nodes (detected problems)
export { IssueNode, type IssueNodeRecord, type IssueSeverity, type IssueType } from './IssueNode.js';

// Plugin nodes (self-describing pipeline)
export { PluginNode, type PluginNodeRecord, type PluginNodeOptions } from './PluginNode.js';

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
  isGrafemaType,
  type BaseNodeType,
  type NamespacedNodeType,
  type NodeType,
} from './NodeKind.js';
