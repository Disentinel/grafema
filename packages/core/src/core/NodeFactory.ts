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
  ExternalStdioNode,
  EventListenerNode,
  HttpRequestNode,
  DatabaseQueryNode,
  type EntrypointType,
  type EntrypointTrigger,
} from './nodes/index.js';

import type { BaseNodeRecord } from '@grafema/types';

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

// Validator type for node classes
interface NodeValidator {
  validate(node: BaseNodeRecord): string[];
}

export class NodeFactory {
  /**
   * Create SERVICE node
   */
  static createService(name: string, projectPath: string, options: ServiceOptions = {}) {
    return ServiceNode.create(name, projectPath, options);
  }

  /**
   * Create ENTRYPOINT node
   */
  static createEntrypoint(file: string, entrypointType: EntrypointType, options: EntrypointOptions = {}) {
    return EntrypointNode.create(file, entrypointType, options);
  }

  /**
   * Create MODULE node
   */
  static createModule(filePath: string, projectPath: string, options: ModuleOptions = {}) {
    if (!filePath) throw new Error('NodeFactory.createModule: filePath is required');
    if (!projectPath) throw new Error('NodeFactory.createModule: projectPath is required');

    const contentHash = options.contentHash || this._hashFile(filePath);
    const relativePath = relative(projectPath, filePath) || basename(filePath);

    return ModuleNode.create(filePath, relativePath, contentHash, options);
  }

  /**
   * Create FUNCTION node
   */
  static createFunction(name: string, file: string, line: number, column: number, options: FunctionOptions = {}) {
    return FunctionNode.create(name, file, line, column, options);
  }

  /**
   * Create SCOPE node
   */
  static createScope(scopeType: string, file: string, line: number, options: ScopeOptions = {}) {
    return ScopeNode.create(scopeType, file, line, options);
  }

  /**
   * Create CALL_SITE node
   */
  static createCallSite(targetName: string, file: string, line: number, column: number, options: CallSiteOptions = {}) {
    return CallSiteNode.create(targetName, file, line, column, options);
  }

  /**
   * Create METHOD_CALL node
   */
  static createMethodCall(objectName: string | undefined, methodName: string, file: string, line: number, column: number, options: MethodCallOptions = {}) {
    return MethodCallNode.create(objectName, methodName, file, line, column, options);
  }

  /**
   * Create VARIABLE_DECLARATION node
   */
  static createVariableDeclaration(name: string, file: string, line: number, column: number, options: VariableOptions = {}) {
    return VariableDeclarationNode.create(name, file, line, column, options);
  }

  /**
   * Create CONSTANT node
   */
  static createConstant(name: string, file: string, line: number, column: number, options: ConstantOptions = {}) {
    return ConstantNode.create(name, file, line, column, options);
  }

  /**
   * Create LITERAL node
   */
  static createLiteral(value: unknown, file: string, line: number, column: number, options: LiteralOptions = {}) {
    return LiteralNode.create(value, file, line, column, options);
  }

  /**
   * Create EXTERNAL_STDIO node (singleton)
   */
  static createExternalStdio() {
    return ExternalStdioNode.create();
  }

  /**
   * Create EVENT_LISTENER node
   */
  static createEventListener(eventName: string, objectName: string | undefined, file: string, line: number, options: EventListenerOptions = {}) {
    return EventListenerNode.create(eventName, objectName, file, line, options);
  }

  /**
   * Create HTTP_REQUEST node
   */
  static createHttpRequest(url: string | undefined, method: string | undefined, file: string, line: number, options: HttpRequestOptions = {}) {
    return HttpRequestNode.create(url, method, file, line, options);
  }

  /**
   * Create DATABASE_QUERY node
   */
  static createDatabaseQuery(query: string | undefined, operation: string | undefined, file: string, line: number, options: DatabaseQueryOptions = {}) {
    return DatabaseQueryNode.create(query, operation, file, line, options);
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
      'EXTERNAL_STDIO': ExternalStdioNode,
      'EVENT_LISTENER': EventListenerNode,
      'HTTP_REQUEST': HttpRequestNode,
      'DATABASE_QUERY': DatabaseQueryNode
    };

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
