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
  CallSiteNode,
  MethodCallNode,
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
  EnumNode,
  DecoratorNode,
  ExpressionNode,
  ArgumentExpressionNode,
  IssueNode,
  type EntrypointType,
  type EntrypointTrigger,
  type DecoratorTargetType,
  type InterfacePropertyRecord,
  type EnumMemberRecord,
  type IssueSeverity,
} from './nodes/index.js';

import type { BaseNodeRecord, BrandedNode } from '@grafema/types';
import { brandNode } from '@grafema/types';
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
  column?: number;
  parentScopeId?: string;
  callbackArg?: string;
  counter?: number;
}

interface HttpRequestOptions {
  column?: number;
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
    return brandNode(ServiceNode.create(name, projectPath, options));
  }

  /**
   * Create ENTRYPOINT node
   */
  static createEntrypoint(file: string, entrypointType: EntrypointType, options: EntrypointOptions = {}) {
    return brandNode(EntrypointNode.create(file, entrypointType, options));
  }

  /**
   * Create MODULE node (LEGACY)
   */
  static createModule(filePath: string, projectPath: string, options: ModuleOptions = {}) {
    if (!filePath) throw new Error('NodeFactory.createModule: filePath is required');
    if (!projectPath) throw new Error('NodeFactory.createModule: projectPath is required');

    const contentHash = options.contentHash || this._hashFile(filePath);
    const relativePath = relative(projectPath, filePath) || basename(filePath);

    return brandNode(ModuleNode.create(filePath, relativePath, contentHash, options));
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
    return brandNode(ModuleNode.createWithContext(context, options));
  }

  /**
   * Create FUNCTION node
   */
  static createFunction(name: string, file: string, line: number, column: number, options: FunctionOptions = {}) {
    return brandNode(FunctionNode.create(name, file, line, column, options));
  }

  /**
   * Create SCOPE node
   */
  static createScope(scopeType: string, file: string, line: number, options: ScopeOptions = {}) {
    return brandNode(ScopeNode.create(scopeType, file, line, options));
  }

  /**
   * Create CALL_SITE node
   */
  static createCallSite(targetName: string, file: string, line: number, column: number, options: CallSiteOptions = {}) {
    return brandNode(CallSiteNode.create(targetName, file, line, column, options));
  }

  /**
   * Create METHOD_CALL node
   */
  static createMethodCall(objectName: string | undefined, methodName: string, file: string, line: number, column: number, options: MethodCallOptions = {}) {
    return brandNode(MethodCallNode.create(objectName, methodName, file, line, column, options));
  }

  /**
   * Create VARIABLE_DECLARATION node
   */
  static createVariableDeclaration(name: string, file: string, line: number, column: number, options: VariableOptions = {}) {
    return brandNode(VariableDeclarationNode.create(name, file, line, column, options));
  }

  /**
   * Create CONSTANT node
   */
  static createConstant(name: string, file: string, line: number, column: number, options: ConstantOptions = {}) {
    return brandNode(ConstantNode.create(name, file, line, column, options));
  }

  /**
   * Create LITERAL node
   */
  static createLiteral(value: unknown, file: string, line: number, column: number, options: LiteralOptions = {}) {
    return brandNode(LiteralNode.create(value, file, line, column, options));
  }

  /**
   * Create OBJECT_LITERAL node
   */
  static createObjectLiteral(file: string, line: number, column: number, options: ObjectLiteralOptions = {}) {
    return brandNode(ObjectLiteralNode.create(file, line, column, options));
  }

  /**
   * Create ARRAY_LITERAL node
   */
  static createArrayLiteral(file: string, line: number, column: number, options: ArrayLiteralOptions = {}) {
    return brandNode(ArrayLiteralNode.create(file, line, column, options));
  }

  /**
   * Create EXTERNAL_STDIO node (singleton)
   */
  static createExternalStdio() {
    return brandNode(ExternalStdioNode.create());
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
    return brandNode(NetworkRequestNode.create());
  }

  /**
   * Create EVENT_LISTENER node
   */
  static createEventListener(eventName: string, objectName: string | undefined, file: string, line: number, options: EventListenerOptions = {}) {
    return brandNode(EventListenerNode.create(eventName, objectName, file, line, options));
  }

  /**
   * Create HTTP_REQUEST node
   */
  static createHttpRequest(url: string | undefined, method: string | undefined, file: string, line: number, options: HttpRequestOptions = {}) {
    return brandNode(HttpRequestNode.create(url, method, file, line, options));
  }

  /**
   * Create DATABASE_QUERY node
   */
  static createDatabaseQuery(query: string | undefined, operation: string | undefined, file: string, line: number, options: DatabaseQueryOptions = {}) {
    return brandNode(DatabaseQueryNode.create(query, operation, file, line, options));
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
    return brandNode(ImportNode.create(name, file, line, column, source, options));
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
    return brandNode(ClassNode.create(name, file, line, column, options));
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
    return brandNode(ExportNode.create(name, file, line, column, options));
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
    return brandNode(ExternalModuleNode.create(source));
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
    return brandNode(InterfaceNode.create(name, file, line, column, options));
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
    return brandNode(TypeNode.create(name, file, line, column, options));
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
    return brandNode(EnumNode.create(name, file, line, column, options));
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
    return brandNode(DecoratorNode.create(name, file, line, column, targetId, targetType, options));
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
    return brandNode(ExpressionNode.create(expressionType, file, line, column, options));
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
    return brandNode(ExpressionNode.createFromMetadata(expressionType, file, line, column, options));
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
    return brandNode(ArgumentExpressionNode.create(expressionType, file, line, column, options));
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
    return brandNode(IssueNode.create(category, severity, message, plugin, file, line, column, options));
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
      'CALL_SITE': CallSiteNode,
      'METHOD_CALL': MethodCallNode,
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
      'ENUM': EnumNode,
      'DECORATOR': DecoratorNode,
      'EXPRESSION': ExpressionNode
    };

    // Handle issue:* types dynamically
    if (IssueNode.isIssueType(node.type)) {
      return IssueNode.validate(node as Parameters<typeof IssueNode.validate>[0]);
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
