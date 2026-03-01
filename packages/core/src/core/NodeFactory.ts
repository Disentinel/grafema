/**
 * NodeFactory - centralized graph node creation (facade)
 *
 * Single point for creating all node types. Delegates to domain-specific
 * factories in ./factories/ while maintaining a unified public API.
 *
 * All callers use NodeFactory.createX() - the domain split is an internal detail.
 */

import {
  ServiceNode,
  EntrypointNode,
  ModuleNode,
  FunctionNode,
  ScopeNode,
  BranchNode,
  CaseNode,
  CallSiteNode,
  MethodCallNode,
  ConstructorCallNode,
  VariableDeclarationNode,
  ConstantNode,
  LiteralNode,
  ObjectLiteralNode,
  ArrayLiteralNode,
  ExternalStdioNode,
  NetworkRequestNode,
  EventListenerNode,
  HttpRequestNode,
  DatabaseQueryNode,
  ImportNode,
  ClassNode,
  ExportNode,
  ExternalModuleNode,
  ExternalFunctionNode,
  EcmascriptBuiltinNode,
  WebApiNode,
  BrowserApiNode,
  NodejsStdlibNode,
  UnknownCallTargetNode,
  InterfaceNode,
  TypeNode,
  TypeParameterNode,
  EnumNode,
  DecoratorNode,
  ExpressionNode,
  IssueNode,
  PluginNode,
  RustModuleNode,
  RustFunctionNode,
  RustStructNode,
  RustImplNode,
  RustMethodNode,
  RustTraitNode,
  RustCallNode,
  ReactNode,
  SocketIONode,
  SocketConnectionNode,
  DatabaseNode,
  RedisNode,
  ServiceLayerNode,
} from './nodes/index.js';

import type { BaseNodeRecord } from '@grafema/types';

import { CoreFactory } from './factories/CoreFactory.js';
import { HttpFactory } from './factories/HttpFactory.js';
import { RustFactory } from './factories/RustFactory.js';
import { ReactFactory } from './factories/ReactFactory.js';
import { SocketFactory } from './factories/SocketFactory.js';
import { DatabaseFactory } from './factories/DatabaseFactory.js';
import { ServiceFactory } from './factories/ServiceFactory.js';
import { ExternalFactory } from './factories/ExternalFactory.js';
import { RedisFactory } from './factories/RedisFactory.js';
import { SystemFactory } from './factories/SystemFactory.js';

// Validator type for node classes
interface NodeValidator {
  validate(node: BaseNodeRecord): string[];
}

export class NodeFactory {
  // ==========================================
  // Core node types (delegate to CoreFactory)
  // ==========================================

  static createService = CoreFactory.createService.bind(CoreFactory);
  static createEntrypoint = CoreFactory.createEntrypoint.bind(CoreFactory);
  static createModule = CoreFactory.createModule.bind(CoreFactory);
  static createModuleWithContext = CoreFactory.createModuleWithContext.bind(CoreFactory);
  static createFunction = CoreFactory.createFunction.bind(CoreFactory);
  static createScope = CoreFactory.createScope.bind(CoreFactory);
  static createBranch = CoreFactory.createBranch.bind(CoreFactory);
  static createCase = CoreFactory.createCase.bind(CoreFactory);
  static createCallSite = CoreFactory.createCallSite.bind(CoreFactory);
  static createMethodCall = CoreFactory.createMethodCall.bind(CoreFactory);
  static createConstructorCall = CoreFactory.createConstructorCall.bind(CoreFactory);
  static generateConstructorCallId = CoreFactory.generateConstructorCallId.bind(CoreFactory);
  static isBuiltinConstructor = CoreFactory.isBuiltinConstructor.bind(CoreFactory);
  static createVariableDeclaration = CoreFactory.createVariableDeclaration.bind(CoreFactory);
  static createConstant = CoreFactory.createConstant.bind(CoreFactory);
  static createLiteral = CoreFactory.createLiteral.bind(CoreFactory);
  static createObjectLiteral = CoreFactory.createObjectLiteral.bind(CoreFactory);
  static createArrayLiteral = CoreFactory.createArrayLiteral.bind(CoreFactory);
  static createExternalStdio = CoreFactory.createExternalStdio.bind(CoreFactory);
  static createEventListener = CoreFactory.createEventListener.bind(CoreFactory);
  static createImport = CoreFactory.createImport.bind(CoreFactory);
  static createClass = CoreFactory.createClass.bind(CoreFactory);
  static createExport = CoreFactory.createExport.bind(CoreFactory);
  static createInterface = CoreFactory.createInterface.bind(CoreFactory);
  static createType = CoreFactory.createType.bind(CoreFactory);
  static createTypeParameter = CoreFactory.createTypeParameter.bind(CoreFactory);
  static createEnum = CoreFactory.createEnum.bind(CoreFactory);
  static createDecorator = CoreFactory.createDecorator.bind(CoreFactory);
  static createExpression = CoreFactory.createExpression.bind(CoreFactory);
  static generateExpressionId = CoreFactory.generateExpressionId.bind(CoreFactory);
  static createExpressionFromMetadata = CoreFactory.createExpressionFromMetadata.bind(CoreFactory);
  static createArgumentExpression = CoreFactory.createArgumentExpression.bind(CoreFactory);
  static createIssue = CoreFactory.createIssue.bind(CoreFactory);
  static createPlugin = CoreFactory.createPlugin.bind(CoreFactory);
  static _hashFile = CoreFactory._hashFile.bind(CoreFactory);

  // ==========================================
  // HTTP domain (delegate to HttpFactory)
  // ==========================================

  static createNetworkRequest = HttpFactory.createNetworkRequest.bind(HttpFactory);
  static createHttpRoute = HttpFactory.createHttpRoute.bind(HttpFactory);
  static createFetchRequest = HttpFactory.createFetchRequest.bind(HttpFactory);
  static createExpressMount = HttpFactory.createExpressMount.bind(HttpFactory);
  static createExpressMiddleware = HttpFactory.createExpressMiddleware.bind(HttpFactory);
  static createExternalApi = HttpFactory.createExternalApi.bind(HttpFactory);
  static createHttpRequest = HttpFactory.createHttpRequest.bind(HttpFactory);

  // ==========================================
  // Rust domain (delegate to RustFactory)
  // ==========================================

  static createRustModule = RustFactory.createRustModule.bind(RustFactory);
  static createRustFunction = RustFactory.createRustFunction.bind(RustFactory);
  static createRustStruct = RustFactory.createRustStruct.bind(RustFactory);
  static createRustImpl = RustFactory.createRustImpl.bind(RustFactory);
  static createRustMethod = RustFactory.createRustMethod.bind(RustFactory);
  static createRustTrait = RustFactory.createRustTrait.bind(RustFactory);
  static createRustCall = RustFactory.createRustCall.bind(RustFactory);

  // ==========================================
  // React domain (delegate to ReactFactory)
  // ==========================================

  static createReactNode = ReactFactory.createReactNode.bind(ReactFactory);

  // ==========================================
  // Socket domain (delegate to SocketFactory)
  // ==========================================

  static createSocketIOEmit = SocketFactory.createSocketIOEmit.bind(SocketFactory);
  static createSocketIOListener = SocketFactory.createSocketIOListener.bind(SocketFactory);
  static createSocketIORoom = SocketFactory.createSocketIORoom.bind(SocketFactory);
  static createSocketIOEvent = SocketFactory.createSocketIOEvent.bind(SocketFactory);
  static createUnixSocket = SocketFactory.createUnixSocket.bind(SocketFactory);
  static createTcpConnection = SocketFactory.createTcpConnection.bind(SocketFactory);
  static createUnixServer = SocketFactory.createUnixServer.bind(SocketFactory);
  static createTcpServer = SocketFactory.createTcpServer.bind(SocketFactory);

  // ==========================================
  // Database domain (delegate to DatabaseFactory)
  // ==========================================

  static createDatabaseQuery = DatabaseFactory.createDatabaseQuery.bind(DatabaseFactory);
  static createDbConnection = DatabaseFactory.createDbConnection.bind(DatabaseFactory);
  static createDbQuery = DatabaseFactory.createDbQuery.bind(DatabaseFactory);
  static createSQLiteQuery = DatabaseFactory.createSQLiteQuery.bind(DatabaseFactory);
  static createDbTable = DatabaseFactory.createDbTable.bind(DatabaseFactory);

  // ==========================================
  // Redis domain (delegate to RedisFactory)
  // ==========================================

  static createRedisOperation = RedisFactory.createRedisOperation.bind(RedisFactory);

  // ==========================================
  // Service Layer (delegate to ServiceFactory)
  // ==========================================

  static createServiceClass = ServiceFactory.createServiceClass.bind(ServiceFactory);
  static createServiceInstance = ServiceFactory.createServiceInstance.bind(ServiceFactory);
  static createServiceRegistration = ServiceFactory.createServiceRegistration.bind(ServiceFactory);
  static createServiceUsage = ServiceFactory.createServiceUsage.bind(ServiceFactory);

  // ==========================================
  // External modules (delegate to ExternalFactory)
  // ==========================================

  static createExternalModule = ExternalFactory.createExternalModule.bind(ExternalFactory);
  static createExternalFunction = ExternalFactory.createExternalFunction.bind(ExternalFactory);
  static createEcmascriptBuiltin = ExternalFactory.createEcmascriptBuiltin.bind(ExternalFactory);
  static createWebApi = ExternalFactory.createWebApi.bind(ExternalFactory);
  static createBrowserApi = ExternalFactory.createBrowserApi.bind(ExternalFactory);
  static createNodejsStdlib = ExternalFactory.createNodejsStdlib.bind(ExternalFactory);
  static createUnknownCallTarget = ExternalFactory.createUnknownCallTarget.bind(ExternalFactory);

  // ==========================================
  // System DB domain (delegate to SystemFactory)
  // ==========================================

  static createSystemDbViewRegistration = SystemFactory.createSystemDbViewRegistration.bind(SystemFactory);
  static createSystemDbSubscription = SystemFactory.createSystemDbSubscription.bind(SystemFactory);

  // ==========================================
  // Core infrastructure (delegate to CoreFactory)
  // ==========================================

  static createGraphMeta = CoreFactory.createGraphMeta.bind(CoreFactory);
  static createGuarantee = CoreFactory.createGuarantee.bind(CoreFactory);

  // ==========================================
  // Validation (stays in facade - needs all node types)
  // ==========================================

  /**
   * Validate node by its type
   */
  static validate(node: BaseNodeRecord): string[] {
    const validators: Record<string, NodeValidator> = {
      'SERVICE': ServiceNode,
      'ENTRYPOINT': EntrypointNode,
      'MODULE': ModuleNode,
      'FUNCTION': FunctionNode,
      'SCOPE': ScopeNode,
      'BRANCH': BranchNode,
      'CASE': CaseNode,
      'CALL_SITE': CallSiteNode,
      'METHOD_CALL': MethodCallNode,
      'CONSTRUCTOR_CALL': ConstructorCallNode,
      'VARIABLE_DECLARATION': VariableDeclarationNode,
      'CONSTANT': ConstantNode,
      'LITERAL': LiteralNode,
      'OBJECT_LITERAL': ObjectLiteralNode,
      'ARRAY_LITERAL': ArrayLiteralNode,
      'net:stdio': ExternalStdioNode,
      'net:request': NetworkRequestNode,
      'EVENT_LISTENER': EventListenerNode,
      'HTTP_REQUEST': HttpRequestNode,
      'DATABASE_QUERY': DatabaseQueryNode,
      'IMPORT': ImportNode,
      'CLASS': ClassNode,
      'EXPORT': ExportNode,
      'EXTERNAL_MODULE': ExternalModuleNode,
      'EXTERNAL_FUNCTION': ExternalFunctionNode,
      'ECMASCRIPT_BUILTIN': EcmascriptBuiltinNode,
      'WEB_API': WebApiNode,
      'BROWSER_API': BrowserApiNode,
      'NODEJS_STDLIB': NodejsStdlibNode,
      'UNKNOWN_CALL_TARGET': UnknownCallTargetNode,
      'INTERFACE': InterfaceNode,
      'TYPE': TypeNode,
      'TYPE_PARAMETER': TypeParameterNode,
      'ENUM': EnumNode,
      'DECORATOR': DecoratorNode,
      'EXPRESSION': ExpressionNode,
      'RUST_MODULE': RustModuleNode,
      'RUST_FUNCTION': RustFunctionNode,
      'RUST_STRUCT': RustStructNode,
      'RUST_IMPL': RustImplNode,
      'RUST_METHOD': RustMethodNode,
      'RUST_TRAIT': RustTraitNode,
      'RUST_CALL': RustCallNode,
    };

    // Handle issue:* types dynamically
    if (IssueNode.isIssueType(node.type)) {
      return IssueNode.validate(node as Parameters<typeof IssueNode.validate>[0]);
    }

    // Handle grafema:plugin type
    if (PluginNode.isPluginType(node.type)) {
      return PluginNode.validate(node);
    }

    // Handle React domain types (react:*, dom:*, browser:*, canvas:*)
    if (ReactNode.isReactDomainType(node.type)) {
      return ReactNode.validate(node);
    }

    // Handle Socket.IO types (socketio:*)
    if (SocketIONode.isSocketIOType(node.type)) {
      return SocketIONode.validate(node);
    }

    // Handle socket types (os:unix-*, net:tcp-*)
    if (SocketConnectionNode.isSocketType(node.type)) {
      return SocketConnectionNode.validate(node);
    }

    // Handle database domain types (db:*)
    if (DatabaseNode.isDatabaseType(node.type)) {
      return DatabaseNode.validate(node);
    }

    // Handle Redis domain types (redis:*)
    if (RedisNode.isRedisType(node.type)) {
      return RedisNode.validate(node);
    }

    // Handle service layer types (SERVICE_*)
    if (ServiceLayerNode.isServiceLayerType(node.type)) {
      return ServiceLayerNode.validate(node);
    }

    // Handle system_db domain types (SYSTEM_DB_*)
    if (SystemFactory.isSystemDbType(node.type)) {
      return SystemFactory.validate(node);
    }

    // Handle core infrastructure types
    if (node.type === 'GRAPH_META' || node.type === 'GUARANTEE') {
      return [];
    }

    const validator = validators[node.type];
    if (!validator) {
      return [`Unknown node type: ${node.type}`];
    }

    return validator.validate(node);
  }
}
