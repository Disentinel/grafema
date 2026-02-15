/**
 * NodeFactory - centralized graph node creation
 *
 * Single point for creating all node types with:
 * - Required field validation
 * - Standard field set for each type
 * - Automatic ID generation
 *
 * Delegates creation to node contracts from ./nodes/
 */

import { createHash } from 'crypto';
import { basename, relative } from 'path';

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
  InterfaceNode,
  TypeNode,
  TypeParameterNode,
  EnumNode,
  DecoratorNode,
  ExpressionNode,
  ArgumentExpressionNode,
  IssueNode,
  PluginNode,
  RustModuleNode,
  RustFunctionNode,
  RustStructNode,
  RustImplNode,
  RustMethodNode,
  RustTraitNode,
  RustCallNode,
  type EntrypointType,
  type EntrypointTrigger,
  type DecoratorTargetType,
  type InterfacePropertyRecord,
  type EnumMemberRecord,
  type IssueSeverity,
  type RustCallType,
  type RustTraitMethodRecord,
  HttpRouteNode,
  type HttpRouteNodeOptions,
  FetchRequestNode,
  type FetchRequestNodeOptions,
  ExpressMountNode,
  type ExpressMountNodeOptions,
  ExpressMiddlewareNode,
  type ExpressMiddlewareNodeOptions,
  ExternalApiNode,
  ReactNode,
  SocketIONode,
  SocketConnectionNode,
} from './nodes/index.js';

import type { BaseNodeRecord } from '@grafema/types';
import { brandNodeInternal } from './brandNodeInternal.js';
import type { ScopeContext } from './SemanticId.js';

interface ServiceOptions {
  version?: string;
  entrypoint?: string;
  discoveryMethod?: string;
  description?: string;
  dependencies?: string[];
  serviceType?: string;
  testFiles?: string[];
  metadata?: {
    type?: string;
    testFiles?: string[];
  };
}

interface EntrypointOptions {
  id?: string;
  name?: string;
  trigger?: EntrypointTrigger;
  source?: string;
  serviceId?: string;
}

interface ModuleOptions {
  contentHash?: string;
  isTest?: boolean;
}

interface ModuleContextOptions {
  contentHash?: string;
  isTest?: boolean;
}

interface FunctionOptions {
  async?: boolean;
  generator?: boolean;
  exported?: boolean;
  arrowFunction?: boolean;
  parentScopeId?: string;
  isClassMethod?: boolean;
  className?: string;
  params?: string[];
  counter?: number;
}

interface ScopeOptions {
  name?: string;
  conditional?: boolean;
  parentScopeId?: string;
  parentFunctionId?: string;
  capturesFrom?: string[];
  counter?: number;
}

interface CallSiteOptions {
  parentScopeId?: string;
  counter?: number;
}

interface MethodCallOptions {
  parentScopeId?: string;
  args?: unknown[];
  counter?: number;
}

interface ConstructorCallOptions {
  counter?: number;
}

interface VariableOptions {
  parentScopeId?: string;
  counter?: number;
}

interface ConstantOptions {
  value?: unknown;
  parentScopeId?: string;
  counter?: number;
}

interface LiteralOptions {
  parentCallId?: string;
  argIndex?: number;
  counter?: number;
}

interface ObjectLiteralOptions {
  parentCallId?: string;
  argIndex?: number;
  counter?: number;
}

interface ArrayLiteralOptions {
  parentCallId?: string;
  argIndex?: number;
  counter?: number;
}

interface EventListenerOptions {
  parentScopeId?: string;
  callbackArg?: string;
  counter?: number;
}

interface HttpRequestOptions {
  parentScopeId?: string;
  counter?: number;
}

interface DatabaseQueryOptions {
  parentScopeId?: string;
}

interface ImportOptions {
  importType?: 'default' | 'named' | 'namespace';
  importBinding?: 'value' | 'type' | 'typeof';
  imported?: string;
  local?: string;
}

interface ClassOptions {
  exported?: boolean;
  superClass?: string;
  methods?: string[];
  isInstantiationRef?: boolean;
}

interface ExportOptions {
  exportKind?: 'value' | 'type';
  local?: string;
  default?: boolean;
  source?: string;
  exportType?: 'default' | 'named' | 'all';
}

interface InterfaceOptions {
  extends?: string[];
  properties?: InterfacePropertyRecord[];
  isExternal?: boolean;
}

interface TypeOptions {
  aliasOf?: string;
  mappedType?: boolean;
  keyName?: string;
  keyConstraint?: string;
  valueType?: string;
  mappedReadonly?: boolean | '+' | '-';
  mappedOptional?: boolean | '+' | '-';
  nameType?: string;
  conditionalType?: boolean;
  checkType?: string;
  extendsType?: string;
  trueType?: string;
  falseType?: string;
}

interface TypeParameterOptions {
  constraint?: string;
  defaultType?: string;
  variance?: 'in' | 'out' | 'in out';
}

interface EnumOptions {
  isConst?: boolean;
  members?: EnumMemberRecord[];
}

interface DecoratorOptions {
  arguments?: unknown[];
}

interface ExpressionOptions {
  // MemberExpression
  object?: string;
  property?: string;
  computed?: boolean;
  computedPropertyVar?: string;
  // Binary/Logical
  operator?: string;
  // Tracking
  path?: string;
  baseName?: string;
  propertyPath?: string[];
  arrayIndex?: number;
}

interface ArgumentExpressionOptions extends ExpressionOptions {
  parentCallId: string;
  argIndex: number;
  counter?: number;
}

// Validator type for node classes
interface NodeValidator {
  validate(node: BaseNodeRecord): string[];
}

export class NodeFactory {
  /**
   * Create SERVICE node
   */
  static createService(name: string, projectPath: string, options: ServiceOptions = {}) {
    return brandNodeInternal(ServiceNode.create(name, projectPath, options));
  }

  /**
   * Create ENTRYPOINT node
   */
  static createEntrypoint(file: string, entrypointType: EntrypointType, options: EntrypointOptions = {}) {
    return brandNodeInternal(EntrypointNode.create(file, entrypointType, options));
  }

  /**
   * Create MODULE node (LEGACY)
   */
  static createModule(filePath: string, projectPath: string, options: ModuleOptions = {}) {
    if (!filePath) throw new Error('NodeFactory.createModule: filePath is required');
    if (!projectPath) throw new Error('NodeFactory.createModule: projectPath is required');

    const contentHash = options.contentHash || this._hashFile(filePath);
    const relativePath = relative(projectPath, filePath) || basename(filePath);

    return brandNodeInternal(ModuleNode.create(relativePath, relativePath, contentHash, options));
  }

  /**
   * Create MODULE node with semantic ID (NEW API)
   *
   * Uses ScopeContext for stable identifiers.
   *
   * @param context - Scope context with file path (relative to project root)
   * @param options - Optional contentHash and isTest flag
   * @returns ModuleNodeRecord with semantic ID
   */
  static createModuleWithContext(context: ScopeContext, options: ModuleContextOptions = {}) {
    return brandNodeInternal(ModuleNode.createWithContext(context, options));
  }

  /**
   * Create FUNCTION node
   */
  static createFunction(name: string, file: string, line: number, column: number, options: FunctionOptions = {}) {
    return brandNodeInternal(FunctionNode.create(name, file, line, column, options));
  }

  /**
   * Create SCOPE node
   */
  static createScope(scopeType: string, file: string, line: number, options: ScopeOptions = {}) {
    return brandNodeInternal(ScopeNode.create(scopeType, file, line, options));
  }

  /**
   * Create BRANCH node
   */
  static createBranch(branchType: 'switch' | 'if' | 'ternary', file: string, line: number, column: number, options: { parentScopeId?: string; counter?: number } = {}) {
    return brandNodeInternal(BranchNode.create(branchType, file, line, column, options));
  }

  /**
   * Create CASE node
   */
  static createCase(
    value: unknown,
    isDefault: boolean,
    fallsThrough: boolean,
    isEmpty: boolean,
    file: string,
    line: number,
    column: number,
    options: { parentBranchId?: string; counter?: number } = {}
  ) {
    return brandNodeInternal(CaseNode.create(value, isDefault, fallsThrough, isEmpty, file, line, column, options));
  }

  /**
   * Create CALL_SITE node
   */
  static createCallSite(targetName: string, file: string, line: number, column: number, options: CallSiteOptions = {}) {
    return brandNodeInternal(CallSiteNode.create(targetName, file, line, column, options));
  }

  /**
   * Create METHOD_CALL node
   */
  static createMethodCall(objectName: string | undefined, methodName: string, file: string, line: number, column: number, options: MethodCallOptions = {}) {
    return brandNodeInternal(MethodCallNode.create(objectName, methodName, file, line, column, options));
  }

  /**
   * Create CONSTRUCTOR_CALL node
   *
   * Represents a `new ClassName()` expression.
   * Used for data flow: VARIABLE --ASSIGNED_FROM--> CONSTRUCTOR_CALL
   *
   * @param className - Name of the constructor (e.g., 'Date', 'MyClass')
   * @param file - File path
   * @param line - Line number
   * @param column - Column position
   * @param options - Optional counter for disambiguation
   */
  static createConstructorCall(className: string, file: string, line: number, column: number, options: ConstructorCallOptions = {}) {
    return brandNodeInternal(ConstructorCallNode.create(className, file, line, column, options));
  }

  /**
   * Generate CONSTRUCTOR_CALL node ID without creating the full node
   *
   * Used by JSASTAnalyzer when creating assignment metadata.
   * The full node is created later by GraphBuilder.
   */
  static generateConstructorCallId(className: string, file: string, line: number, column: number, options: ConstructorCallOptions = {}): string {
    return ConstructorCallNode.generateId(className, file, line, column, options);
  }

  /**
   * Check if a class name is a built-in JavaScript constructor
   */
  static isBuiltinConstructor(className: string): boolean {
    return ConstructorCallNode.isBuiltinConstructor(className);
  }

  /**
   * Create VARIABLE_DECLARATION node
   */
  static createVariableDeclaration(name: string, file: string, line: number, column: number, options: VariableOptions = {}) {
    return brandNodeInternal(VariableDeclarationNode.create(name, file, line, column, options));
  }

  /**
   * Create CONSTANT node
   */
  static createConstant(name: string, file: string, line: number, column: number, options: ConstantOptions = {}) {
    return brandNodeInternal(ConstantNode.create(name, file, line, column, options));
  }

  /**
   * Create LITERAL node
   */
  static createLiteral(value: unknown, file: string, line: number, column: number, options: LiteralOptions = {}) {
    return brandNodeInternal(LiteralNode.create(value, file, line, column, options));
  }

  /**
   * Create OBJECT_LITERAL node
   */
  static createObjectLiteral(file: string, line: number, column: number, options: ObjectLiteralOptions = {}) {
    return brandNodeInternal(ObjectLiteralNode.create(file, line, column, options));
  }

  /**
   * Create ARRAY_LITERAL node
   */
  static createArrayLiteral(file: string, line: number, column: number, options: ArrayLiteralOptions = {}) {
    return brandNodeInternal(ArrayLiteralNode.create(file, line, column, options));
  }

  /**
   * Create EXTERNAL_STDIO node (singleton)
   */
  static createExternalStdio() {
    return brandNodeInternal(ExternalStdioNode.create());
  }

  /**
   * Create net:request singleton node
   *
   * This node represents the external network as a system resource.
   * Should be created once per graph.
   *
   * All HTTP_REQUEST nodes connect to this singleton via CALLS edges.
   *
   * @returns NetworkRequestNodeRecord - singleton node
   */
  static createNetworkRequest() {
    return brandNodeInternal(NetworkRequestNode.create());
  }

  /**
   * Create http:route node
   *
   * Represents an HTTP route endpoint from Express, NestJS, or other frameworks.
   *
   * @param method - HTTP method (GET, POST, PUT, DELETE, etc.)
   * @param path - Route path (e.g., "/api/users")
   * @param file - File path where route is defined
   * @param line - Line number
   * @param options - Optional framework-specific metadata
   */
  static createHttpRoute(method: string, path: string, file: string, line: number, options: HttpRouteNodeOptions = {}) {
    return brandNodeInternal(HttpRouteNode.create(method, path, file, line, options));
  }

  /**
   * Create http:request node (namespaced)
   *
   * Represents an HTTP request call site from fetch(), axios, or custom wrappers.
   * NOT the same as createHttpRequest() which creates HTTP_REQUEST (uppercase) nodes.
   *
   * @param method - HTTP method
   * @param url - Request URL or 'dynamic'/'unknown'
   * @param library - Library name ('fetch', 'axios', or wrapper name)
   * @param file - File path
   * @param line - Line number
   * @param column - Column number
   * @param options - Optional fields
   */
  static createFetchRequest(method: string, url: string, library: string, file: string, line: number, column: number, options: FetchRequestNodeOptions = {}) {
    return brandNodeInternal(FetchRequestNode.create(method, url, library, file, line, column, options));
  }

  /**
   * Create express:mount node
   *
   * Represents an Express.js mount point (app.use('/prefix', router)).
   *
   * @param prefix - Mount path prefix
   * @param file - File path
   * @param line - Line number
   * @param column - Column number
   * @param options - Optional target function/variable info
   */
  static createExpressMount(prefix: string, file: string, line: number, column: number, options: ExpressMountNodeOptions = {}) {
    return brandNodeInternal(ExpressMountNode.create(prefix, file, line, column, options));
  }

  /**
   * Create express:middleware node
   *
   * Represents middleware in an Express.js route chain or global mount.
   *
   * @param name - Middleware name
   * @param file - File path
   * @param line - Line number
   * @param column - Column number
   * @param options - Optional endpoint/mount metadata
   */
  static createExpressMiddleware(name: string, file: string, line: number, column: number, options: ExpressMiddlewareNodeOptions = {}) {
    return brandNodeInternal(ExpressMiddlewareNode.create(name, file, line, column, options));
  }

  /**
   * Create EXTERNAL node for an API domain
   *
   * Represents an external API domain detected from HTTP request URLs.
   *
   * @param domain - External API domain (e.g., "api.github.com")
   */
  static createExternalApi(domain: string) {
    return brandNodeInternal(ExternalApiNode.create(domain));
  }

  /**
   * Create EVENT_LISTENER node
   */
  static createEventListener(eventName: string, objectName: string | undefined, file: string, line: number, column: number, options: EventListenerOptions = {}) {
    return brandNodeInternal(EventListenerNode.create(eventName, objectName, file, line, column, options));
  }

  /**
   * Create HTTP_REQUEST node
   */
  static createHttpRequest(url: string | undefined, method: string | undefined, file: string, line: number, column: number, options: HttpRequestOptions = {}) {
    return brandNodeInternal(HttpRequestNode.create(url, method, file, line, column, options));
  }

  /**
   * Create DATABASE_QUERY node
   */
  static createDatabaseQuery(query: string | undefined, operation: string | undefined, file: string, line: number, column: number, options: DatabaseQueryOptions = {}) {
    return brandNodeInternal(DatabaseQueryNode.create(query, operation, file, line, column, options));
  }

  /**
   * Create IMPORT node
   *
   * ImportNode automatically detects importType from imported field:
   * - imported === 'default' → importType: 'default'
   * - imported === '*' → importType: 'namespace'
   * - anything else → importType: 'named'
   *
   * @param name - Local binding name (how it's used in this file)
   * @param file - Absolute file path
   * @param line - Line number (for debugging, not part of ID)
   * @param column - Column position (0 if unavailable)
   * @param source - Source module (e.g., 'react', './utils')
   * @param options - Optional fields
   * @returns ImportNodeRecord
   */
  static createImport(
    name: string,
    file: string,
    line: number,
    column: number,
    source: string,
    options: ImportOptions = {}
  ) {
    return brandNodeInternal(ImportNode.create(name, file, line, column, source, options));
  }

  /**
   * Create CLASS node
   */
  static createClass(
    name: string,
    file: string,
    line: number,
    column: number,
    options: ClassOptions = {}
  ) {
    return brandNodeInternal(ClassNode.create(name, file, line, column, options));
  }

  /**
   * Create EXPORT node
   */
  static createExport(
    name: string,
    file: string,
    line: number,
    column: number,
    options: ExportOptions = {}
  ) {
    return brandNodeInternal(ExportNode.create(name, file, line, column, options));
  }

  /**
   * Create EXTERNAL_MODULE node
   *
   * Represents external npm packages or Node.js built-in modules.
   * Uses singleton pattern - same source always produces same ID.
   *
   * @param source - Module name (e.g., 'lodash', '@tanstack/react-query', 'node:fs')
   */
  static createExternalModule(source: string) {
    return brandNodeInternal(ExternalModuleNode.create(source));
  }

  /**
   * Create INTERFACE node
   */
  static createInterface(
    name: string,
    file: string,
    line: number,
    column: number,
    options: InterfaceOptions = {}
  ) {
    return brandNodeInternal(InterfaceNode.create(name, file, line, column, options));
  }

  /**
   * Create TYPE node
   */
  static createType(
    name: string,
    file: string,
    line: number,
    column: number,
    options: TypeOptions = {}
  ) {
    return brandNodeInternal(TypeNode.create(name, file, line, column, options));
  }

  /**
   * Create TYPE_PARAMETER node
   *
   * Represents a generic type parameter (<T extends Constraint = Default>).
   *
   * @param name - Type parameter name ("T", "K", "V")
   * @param parentId - ID of the owning declaration (function/class/interface/type)
   * @param file - File path
   * @param line - Line number
   * @param column - Column position
   * @param options - Optional constraint, defaultType, variance
   */
  static createTypeParameter(
    name: string,
    parentId: string,
    file: string,
    line: number,
    column: number,
    options: TypeParameterOptions = {}
  ) {
    return brandNodeInternal(TypeParameterNode.create(name, parentId, file, line, column, options));
  }

  /**
   * Create ENUM node
   */
  static createEnum(
    name: string,
    file: string,
    line: number,
    column: number,
    options: EnumOptions = {}
  ) {
    return brandNodeInternal(EnumNode.create(name, file, line, column, options));
  }

  /**
   * Create DECORATOR node
   */
  static createDecorator(
    name: string,
    file: string,
    line: number,
    column: number,
    targetId: string,
    targetType: DecoratorTargetType,
    options: DecoratorOptions = {}
  ) {
    return brandNodeInternal(DecoratorNode.create(name, file, line, column, targetId, targetType, options));
  }

  /**
   * Create EXPRESSION node
   */
  static createExpression(
    expressionType: string,
    file: string,
    line: number,
    column: number,
    options: ExpressionOptions = {}
  ) {
    return brandNodeInternal(ExpressionNode.create(expressionType, file, line, column, options));
  }

  /**
   * Generate EXPRESSION node ID without creating the full node
   *
   * Used by JSASTAnalyzer when creating assignment metadata.
   * The full node is created later by GraphBuilder.
   *
   * @param expressionType - Type of expression (MemberExpression, BinaryExpression, etc.)
   * @param file - File path
   * @param line - Line number
   * @param column - Column position
   * @returns Generated ID string in colon format
   */
  static generateExpressionId(
    expressionType: string,
    file: string,
    line: number,
    column: number
  ): string {
    return ExpressionNode.generateId(expressionType, file, line, column);
  }

  /**
   * Create EXPRESSION node from assignment metadata
   *
   * Used by GraphBuilder when processing variableAssignments.
   * The ID is provided from upstream (generated by JSASTAnalyzer).
   *
   * @param expressionType - Type of expression
   * @param file - File path
   * @param line - Line number
   * @param column - Column position
   * @param options - Must include id; optional: expression properties
   */
  static createExpressionFromMetadata(
    expressionType: string,
    file: string,
    line: number,
    column: number,
    options: ExpressionOptions & { id: string }
  ) {
    return brandNodeInternal(ExpressionNode.createFromMetadata(expressionType, file, line, column, options));
  }

  /**
   * Create EXPRESSION node with argument context
   *
   * Used when EXPRESSION appears as a call argument and we need to track
   * which call and argument position for data flow analysis.
   *
   * @param expressionType - Type of expression (BinaryExpression, LogicalExpression, etc.)
   * @param file - File path
   * @param line - Line number
   * @param column - Column position
   * @param options - Required: parentCallId, argIndex; Optional: expression properties, counter
   * @returns ArgumentExpressionNodeRecord
   */
  static createArgumentExpression(
    expressionType: string,
    file: string,
    line: number,
    column: number,
    options: ArgumentExpressionOptions
  ) {
    return brandNodeInternal(ArgumentExpressionNode.create(expressionType, file, line, column, options));
  }

  /**
   * Create ISSUE node
   *
   * Issues represent detected problems in the codebase.
   * Used by validation plugins to persist findings in the graph.
   *
   * @param category - Issue category (security, performance, style, smell)
   * @param severity - error | warning | info
   * @param message - Human-readable description
   * @param plugin - Name of the plugin that detected this issue
   * @param file - File path where issue was detected
   * @param line - Line number
   * @param column - Column number (optional)
   * @param options - Optional context data
   */
  static createIssue(
    category: string,
    severity: IssueSeverity,
    message: string,
    plugin: string,
    file: string,
    line: number,
    column: number = 0,
    options: { context?: Record<string, unknown> } = {}
  ) {
    return brandNodeInternal(IssueNode.create(category, severity, message, plugin, file, line, column, options));
  }

  /**
   * Create grafema:plugin node.
   *
   * Represents a Grafema plugin in the analysis pipeline.
   * Created by the Orchestrator at startup to make the pipeline
   * queryable via the graph.
   *
   * @param name - Plugin class name (e.g., 'HTTPConnectionEnricher')
   * @param phase - Plugin phase (DISCOVERY, INDEXING, ANALYSIS, ENRICHMENT, VALIDATION)
   * @param options - Optional fields (priority, file, builtin, creates, dependencies)
   */
  static createPlugin(
    name: string,
    phase: string,
    options: {
      priority?: number;
      file?: string;
      line?: number;
      builtin?: boolean;
      createsNodes?: string[];
      createsEdges?: string[];
      dependencies?: string[];
    } = {}
  ) {
    return brandNodeInternal(PluginNode.create(name, phase, options));
  }

  // ==========================================
  // Rust node factory methods
  // ==========================================

  /**
   * Create RUST_MODULE node
   *
   * Represents a Rust source file (.rs) in the graph.
   *
   * @param moduleName - Rust module name (e.g., "crate", "ffi::napi_bindings")
   * @param file - Absolute file path
   * @param contentHash - SHA-256 hash of file content
   * @param prefixedPath - Relative path, possibly prefixed for multi-root workspaces
   * @param options - Optional flags (isLib, isMod, isTest)
   */
  static createRustModule(
    moduleName: string,
    file: string,
    contentHash: string,
    prefixedPath: string,
    options: { isLib?: boolean; isMod?: boolean; isTest?: boolean } = {}
  ) {
    return brandNodeInternal(RustModuleNode.create(moduleName, file, contentHash, prefixedPath, options));
  }

  /**
   * Create RUST_FUNCTION node
   *
   * Represents a top-level Rust function.
   *
   * @param name - Function name
   * @param file - File path
   * @param line - Line number
   * @param column - Column position
   * @param options - Optional function attributes (pub, async, napi, etc.)
   */
  static createRustFunction(
    name: string,
    file: string,
    line: number,
    column: number,
    options: {
      pub?: boolean;
      async?: boolean;
      unsafe?: boolean;
      const?: boolean;
      napi?: boolean;
      napiJsName?: string | null;
      napiConstructor?: boolean;
      napiGetter?: string | null;
      napiSetter?: string | null;
      params?: string[];
      returnType?: string | null;
      unsafeBlocks?: number;
    } = {}
  ) {
    return brandNodeInternal(RustFunctionNode.create(name, file, line, column, options));
  }

  /**
   * Create RUST_STRUCT node
   *
   * Represents a Rust struct definition.
   *
   * @param name - Struct name
   * @param file - File path
   * @param line - Line number
   * @param options - Optional struct attributes (pub, napi, fields)
   */
  static createRustStruct(
    name: string,
    file: string,
    line: number,
    options: { pub?: boolean; napi?: boolean; fields?: unknown[] } = {}
  ) {
    return brandNodeInternal(RustStructNode.create(name, file, line, options));
  }

  /**
   * Create RUST_IMPL node
   *
   * Represents a Rust impl block (inherent or trait impl).
   *
   * @param targetType - The type being implemented
   * @param file - File path
   * @param line - Line number
   * @param options - Optional traitName for trait implementations
   */
  static createRustImpl(
    targetType: string,
    file: string,
    line: number,
    options: { traitName?: string | null } = {}
  ) {
    return brandNodeInternal(RustImplNode.create(targetType, file, line, options));
  }

  /**
   * Create RUST_METHOD node
   *
   * Represents a method inside a Rust impl block.
   *
   * @param name - Method name
   * @param file - File path
   * @param line - Line number
   * @param column - Column position
   * @param implId - ID of the parent RUST_IMPL node
   * @param implType - Target type of the parent impl block
   * @param options - Optional method attributes
   */
  static createRustMethod(
    name: string,
    file: string,
    line: number,
    column: number,
    implId: string,
    implType: string,
    options: {
      pub?: boolean;
      async?: boolean;
      unsafe?: boolean;
      const?: boolean;
      napi?: boolean;
      napiJsName?: string | null;
      napiConstructor?: boolean;
      napiGetter?: string | null;
      napiSetter?: string | null;
      params?: string[];
      returnType?: string | null;
      selfType?: string | null;
      unsafeBlocks?: number;
    } = {}
  ) {
    return brandNodeInternal(RustMethodNode.create(name, file, line, column, implId, implType, options));
  }

  /**
   * Create RUST_TRAIT node
   *
   * Represents a Rust trait definition.
   *
   * @param name - Trait name
   * @param file - File path
   * @param line - Line number
   * @param options - Optional trait attributes (pub, methods)
   */
  static createRustTrait(
    name: string,
    file: string,
    line: number,
    options: {
      pub?: boolean;
      methods?: RustTraitMethodRecord[];
    } = {}
  ) {
    return brandNodeInternal(RustTraitNode.create(name, file, line, options));
  }

  /**
   * Create RUST_CALL node
   *
   * Represents a function/method/macro call inside a Rust function or method.
   *
   * @param parentName - Name of the containing function/method (used in ID)
   * @param file - File path
   * @param line - Line number
   * @param column - Column position
   * @param callType - "function" | "method" | "macro"
   * @param argsCount - Number of arguments
   * @param options - Optional call attributes (name, receiver, method, sideEffect)
   */
  static createRustCall(
    parentName: string,
    file: string,
    line: number,
    column: number,
    callType: RustCallType,
    argsCount: number,
    options: {
      name?: string | null;
      receiver?: string | null;
      method?: string | null;
      sideEffect?: string | null;
    } = {}
  ) {
    return brandNodeInternal(RustCallNode.create(parentName, file, line, column, callType, argsCount, options));
  }

  // ==========================================
  // React domain factory methods
  // ==========================================

  /**
   * Brand a React domain node (react:*, dom:*, browser:*, canvas:*)
   *
   * React nodes have diverse shapes created by react-internal/ helper modules.
   * This method validates required fields and brands the node for graph insertion.
   *
   * @param fields - Complete node fields including id, type, file, line
   * @returns Branded node ready for graph.addNodes()
   */
  static createReactNode<T extends { id: string; type: string; file: string; line: number }>(fields: T) {
    return brandNodeInternal(ReactNode.create(fields));
  }

  // ==========================================
  // Socket.IO factory methods
  // ==========================================

  /**
   * Create socketio:emit node
   *
   * @param event - Event name (e.g., "slot:booked")
   * @param objectName - Object that emits (e.g., "io", "socket")
   * @param file - File path
   * @param line - Line number
   * @param column - Column position
   * @param options - Optional room, namespace, broadcast
   */
  static createSocketIOEmit(
    event: string,
    objectName: string,
    file: string,
    line: number,
    column: number,
    options: { room?: string | null; namespace?: string | null; broadcast?: boolean } = {}
  ) {
    return brandNodeInternal(SocketIONode.createEmit(event, objectName, file, line, column, options));
  }

  /**
   * Create socketio:on listener node
   *
   * @param event - Event name
   * @param objectName - Object that listens (e.g., "socket")
   * @param handlerName - Handler function name
   * @param handlerLine - Handler function line number
   * @param file - File path
   * @param line - Line number
   * @param column - Column position
   */
  static createSocketIOListener(
    event: string,
    objectName: string,
    handlerName: string,
    handlerLine: number,
    file: string,
    line: number,
    column: number
  ) {
    return brandNodeInternal(SocketIONode.createListener(event, objectName, handlerName, handlerLine, file, line, column));
  }

  /**
   * Create socketio:room node
   *
   * @param roomName - Room name
   * @param objectName - Object that joins (e.g., "socket")
   * @param file - File path
   * @param line - Line number
   * @param column - Column position
   */
  static createSocketIORoom(
    roomName: string,
    objectName: string,
    file: string,
    line: number,
    column: number
  ) {
    return brandNodeInternal(SocketIONode.createRoom(roomName, objectName, file, line, column));
  }

  /**
   * Create socketio:event channel node (singleton per event name)
   *
   * @param eventName - Event name
   */
  static createSocketIOEvent(eventName: string) {
    return brandNodeInternal(SocketIONode.createEvent(eventName));
  }

  // ==========================================
  // Socket (net module) factory methods
  // ==========================================

  /**
   * Create os:unix-socket client connection node
   */
  static createUnixSocket(
    path: string,
    file: string,
    line: number,
    column: number,
    options: { library?: string } = {}
  ) {
    return brandNodeInternal(SocketConnectionNode.createUnixSocket(path, file, line, column, options));
  }

  /**
   * Create net:tcp-connection client node
   */
  static createTcpConnection(
    host: string,
    port: number,
    file: string,
    line: number,
    column: number,
    options: { library?: string } = {}
  ) {
    return brandNodeInternal(SocketConnectionNode.createTcpConnection(host, port, file, line, column, options));
  }

  /**
   * Create os:unix-server node
   */
  static createUnixServer(
    path: string,
    file: string,
    line: number,
    column: number,
    options: { library?: string; backlog?: number } = {}
  ) {
    return brandNodeInternal(SocketConnectionNode.createUnixServer(path, file, line, column, options));
  }

  /**
   * Create net:tcp-server node
   */
  static createTcpServer(
    host: string,
    port: number,
    file: string,
    line: number,
    column: number,
    options: { library?: string; backlog?: number } = {}
  ) {
    return brandNodeInternal(SocketConnectionNode.createTcpServer(host, port, file, line, column, options));
  }

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

    const validator = validators[node.type];
    if (!validator) {
      return [`Unknown node type: ${node.type}`];
    }

    return validator.validate(node);
  }

  /**
   * Helper: hash file path for stable ID
   */
  static _hashFile(filePath: string): string {
    return createHash('md5').update(filePath).digest('hex').substring(0, 12);
  }
}
