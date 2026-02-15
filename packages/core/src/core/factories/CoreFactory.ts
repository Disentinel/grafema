/**
 * CoreFactory - factory methods for core graph node types
 *
 * Handles: SERVICE, ENTRYPOINT, MODULE, FUNCTION, SCOPE, BRANCH, CASE,
 * CALL_SITE, METHOD_CALL, CONSTRUCTOR_CALL, VARIABLE_DECLARATION, CONSTANT,
 * LITERAL, OBJECT_LITERAL, ARRAY_LITERAL, net:stdio, EVENT_LISTENER,
 * IMPORT, CLASS, EXPORT, INTERFACE, TYPE, TYPE_PARAMETER, ENUM, DECORATOR,
 * EXPRESSION, ISSUE, grafema:plugin
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
  EventListenerNode,
  ImportNode,
  ClassNode,
  ExportNode,
  InterfaceNode,
  TypeNode,
  TypeParameterNode,
  EnumNode,
  DecoratorNode,
  ExpressionNode,
  ArgumentExpressionNode,
  IssueNode,
  PluginNode,
  type EntrypointType,
  type EntrypointTrigger,
  type DecoratorTargetType,
  type InterfacePropertyRecord,
  type EnumMemberRecord,
  type IssueSeverity,
} from '../nodes/index.js';

import { brandNodeInternal } from '../brandNodeInternal.js';
import type { ScopeContext } from '../SemanticId.js';

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

export class CoreFactory {
  static createService(name: string, projectPath: string, options: ServiceOptions = {}) {
    return brandNodeInternal(ServiceNode.create(name, projectPath, options));
  }

  static createEntrypoint(file: string, entrypointType: EntrypointType, options: EntrypointOptions = {}) {
    return brandNodeInternal(EntrypointNode.create(file, entrypointType, options));
  }

  static createModule(filePath: string, projectPath: string, options: ModuleOptions = {}) {
    if (!filePath) throw new Error('NodeFactory.createModule: filePath is required');
    if (!projectPath) throw new Error('NodeFactory.createModule: projectPath is required');

    const contentHash = options.contentHash || this._hashFile(filePath);
    const relativePath = relative(projectPath, filePath) || basename(filePath);

    return brandNodeInternal(ModuleNode.create(relativePath, relativePath, contentHash, options));
  }

  static createModuleWithContext(context: ScopeContext, options: ModuleContextOptions = {}) {
    return brandNodeInternal(ModuleNode.createWithContext(context, options));
  }

  static createFunction(name: string, file: string, line: number, column: number, options: FunctionOptions = {}) {
    return brandNodeInternal(FunctionNode.create(name, file, line, column, options));
  }

  static createScope(scopeType: string, file: string, line: number, options: ScopeOptions = {}) {
    return brandNodeInternal(ScopeNode.create(scopeType, file, line, options));
  }

  static createBranch(branchType: 'switch' | 'if' | 'ternary', file: string, line: number, column: number, options: { parentScopeId?: string; counter?: number } = {}) {
    return brandNodeInternal(BranchNode.create(branchType, file, line, column, options));
  }

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

  static createCallSite(targetName: string, file: string, line: number, column: number, options: CallSiteOptions = {}) {
    return brandNodeInternal(CallSiteNode.create(targetName, file, line, column, options));
  }

  static createMethodCall(objectName: string | undefined, methodName: string, file: string, line: number, column: number, options: MethodCallOptions = {}) {
    return brandNodeInternal(MethodCallNode.create(objectName, methodName, file, line, column, options));
  }

  static createConstructorCall(className: string, file: string, line: number, column: number, options: ConstructorCallOptions = {}) {
    return brandNodeInternal(ConstructorCallNode.create(className, file, line, column, options));
  }

  static generateConstructorCallId(className: string, file: string, line: number, column: number, options: ConstructorCallOptions = {}): string {
    return ConstructorCallNode.generateId(className, file, line, column, options);
  }

  static isBuiltinConstructor(className: string): boolean {
    return ConstructorCallNode.isBuiltinConstructor(className);
  }

  static createVariableDeclaration(name: string, file: string, line: number, column: number, options: VariableOptions = {}) {
    return brandNodeInternal(VariableDeclarationNode.create(name, file, line, column, options));
  }

  static createConstant(name: string, file: string, line: number, column: number, options: ConstantOptions = {}) {
    return brandNodeInternal(ConstantNode.create(name, file, line, column, options));
  }

  static createLiteral(value: unknown, file: string, line: number, column: number, options: LiteralOptions = {}) {
    return brandNodeInternal(LiteralNode.create(value, file, line, column, options));
  }

  static createObjectLiteral(file: string, line: number, column: number, options: ObjectLiteralOptions = {}) {
    return brandNodeInternal(ObjectLiteralNode.create(file, line, column, options));
  }

  static createArrayLiteral(file: string, line: number, column: number, options: ArrayLiteralOptions = {}) {
    return brandNodeInternal(ArrayLiteralNode.create(file, line, column, options));
  }

  static createExternalStdio() {
    return brandNodeInternal(ExternalStdioNode.create());
  }

  static createEventListener(eventName: string, objectName: string | undefined, file: string, line: number, column: number, options: EventListenerOptions = {}) {
    return brandNodeInternal(EventListenerNode.create(eventName, objectName, file, line, column, options));
  }

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

  static createClass(
    name: string,
    file: string,
    line: number,
    column: number,
    options: ClassOptions = {}
  ) {
    return brandNodeInternal(ClassNode.create(name, file, line, column, options));
  }

  static createExport(
    name: string,
    file: string,
    line: number,
    column: number,
    options: ExportOptions = {}
  ) {
    return brandNodeInternal(ExportNode.create(name, file, line, column, options));
  }

  static createInterface(
    name: string,
    file: string,
    line: number,
    column: number,
    options: InterfaceOptions = {}
  ) {
    return brandNodeInternal(InterfaceNode.create(name, file, line, column, options));
  }

  static createType(
    name: string,
    file: string,
    line: number,
    column: number,
    options: TypeOptions = {}
  ) {
    return brandNodeInternal(TypeNode.create(name, file, line, column, options));
  }

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

  static createEnum(
    name: string,
    file: string,
    line: number,
    column: number,
    options: EnumOptions = {}
  ) {
    return brandNodeInternal(EnumNode.create(name, file, line, column, options));
  }

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

  static createExpression(
    expressionType: string,
    file: string,
    line: number,
    column: number,
    options: ExpressionOptions = {}
  ) {
    return brandNodeInternal(ExpressionNode.create(expressionType, file, line, column, options));
  }

  static generateExpressionId(
    expressionType: string,
    file: string,
    line: number,
    column: number
  ): string {
    return ExpressionNode.generateId(expressionType, file, line, column);
  }

  static createExpressionFromMetadata(
    expressionType: string,
    file: string,
    line: number,
    column: number,
    options: ExpressionOptions & { id: string }
  ) {
    return brandNodeInternal(ExpressionNode.createFromMetadata(expressionType, file, line, column, options));
  }

  static createArgumentExpression(
    expressionType: string,
    file: string,
    line: number,
    column: number,
    options: ArgumentExpressionOptions
  ) {
    return brandNodeInternal(ArgumentExpressionNode.create(expressionType, file, line, column, options));
  }

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

  static _hashFile(filePath: string): string {
    return createHash('md5').update(filePath).digest('hex').substring(0, 12);
  }
}
