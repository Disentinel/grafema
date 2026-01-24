/**
 * FunctionVisitor - handles function declarations and arrow functions
 *
 * Handles:
 * - FunctionDeclaration
 * - ArrowFunctionExpression (module-level)
 */

import type {
  Node,
  Function,
  FunctionDeclaration,
  ArrowFunctionExpression,
  Identifier,
  AssignmentPattern,
  RestElement,
  VariableDeclarator,
  Comment
} from '@babel/types';
import type { NodePath } from '@babel/traverse';
import { ASTVisitor, type VisitorModule, type VisitorCollections, type VisitorHandlers, type CounterRef } from './ASTVisitor.js';
import { typeNodeToString } from './TypeScriptVisitor.js';
import { ScopeTracker } from '../../../../core/ScopeTracker.js';
import { IdGenerator } from '../IdGenerator.js';
import { createParameterNodes } from '../utils/createParameterNodes.js';
import type { ParameterInfo } from '../types.js';

/**
 * Function node info
 */
interface FunctionInfo {
  id: string;
  type: 'FUNCTION';
  name: string;
  file: string;
  line: number;
  column?: number;
  async: boolean;
  generator?: boolean;
  arrowFunction?: boolean;
  params?: string[];
  paramTypes?: string[];
  returnType?: string;
  signature?: string;
  jsdocSummary?: string;
}

/**
 * Scope node info
 */
interface ScopeInfo {
  id: string;
  type: 'SCOPE';
  scopeType: string;
  name: string;
  conditional?: boolean;
  file: string;
  line: number;
  parentFunctionId: string;
}

/**
 * Callback type for analyzing function bodies
 */
export type AnalyzeFunctionBodyCallback = (
  path: NodePath<Function>,
  scopeId: string,
  module: VisitorModule,
  collections: VisitorCollections
) => void;

export class FunctionVisitor extends ASTVisitor {
  private analyzeFunctionBody: AnalyzeFunctionBodyCallback;
  private scopeTracker: ScopeTracker;

  /**
   * @param module - Current module being analyzed
   * @param collections - Must contain arrays and counter refs
   * @param analyzeFunctionBody - Callback to analyze function internals
   * @param scopeTracker - REQUIRED for semantic ID generation
   */
  constructor(
    module: VisitorModule,
    collections: VisitorCollections,
    analyzeFunctionBody: AnalyzeFunctionBodyCallback,
    scopeTracker: ScopeTracker
  ) {
    super(module, collections);
    this.analyzeFunctionBody = analyzeFunctionBody;
    this.scopeTracker = scopeTracker;
  }

  getHandlers(): VisitorHandlers {
    const { module } = this;
    const functions = this.collections.functions ?? [];
    const parameters = this.collections.parameters ?? [];
    const scopes = this.collections.scopes ?? [];
    const functionCounterRef = (this.collections.functionCounterRef ?? { value: 0 }) as CounterRef;
    const scopeTracker = this.scopeTracker;

    const analyzeFunctionBody = this.analyzeFunctionBody;
    const collections = this.collections;

    // Helper function to generate stable anonymous function name
    const generateAnonymousName = (): string => {
      const index = scopeTracker.getSiblingIndex('anonymous');
      return `anonymous[${index}]`;
    };

    // Helper function to extract parameter names and types from function params
    const extractParamInfo = (params: Node[]): { names: string[]; types: string[] } => {
      const names: string[] = [];
      const types: string[] = [];

      params.forEach((param) => {
        if (param.type === 'Identifier') {
          const id = param as Identifier;
          names.push(id.name);
          // Check for type annotation
          const typeAnnotation = (id as any).typeAnnotation?.typeAnnotation;
          types.push(typeAnnotation ? typeNodeToString(typeAnnotation) : 'any');
        } else if (param.type === 'AssignmentPattern') {
          const assignmentParam = param as AssignmentPattern;
          if (assignmentParam.left.type === 'Identifier') {
            const id = assignmentParam.left as Identifier;
            names.push(id.name + '?');
            const typeAnnotation = (id as any).typeAnnotation?.typeAnnotation;
            types.push(typeAnnotation ? typeNodeToString(typeAnnotation) : 'any');
          }
        } else if (param.type === 'RestElement') {
          const restParam = param as unknown as RestElement;
          if (restParam.argument.type === 'Identifier') {
            const id = restParam.argument as Identifier;
            names.push('...' + id.name);
            const typeAnnotation = (id as any).typeAnnotation?.typeAnnotation;
            types.push(typeAnnotation ? typeNodeToString(typeAnnotation) : 'any[]');
          }
        }
      });

      return { names, types };
    };

    // Helper function to extract return type from function
    const extractReturnType = (node: Function): string => {
      const returnTypeAnnotation = (node as any).returnType?.typeAnnotation;
      if (returnTypeAnnotation) {
        return typeNodeToString(returnTypeAnnotation);
      }
      return 'void';
    };

    // Helper function to extract JSDoc summary from leading comments
    const extractJsdocSummary = (node: Node): string | undefined => {
      const comments = node.leadingComments as Comment[] | null | undefined;
      if (!comments || comments.length === 0) return undefined;

      // Find the last block comment that looks like JSDoc
      for (let i = comments.length - 1; i >= 0; i--) {
        const comment = comments[i];
        if (comment.type === 'CommentBlock' && comment.value.startsWith('*')) {
          // Parse JSDoc - get first non-empty line after the opening
          const lines = comment.value.split('\n');
          for (const line of lines) {
            const trimmed = line.replace(/^\s*\*\s?/, '').trim();
            // Skip empty lines and @tags
            if (trimmed && !trimmed.startsWith('@')) {
              return trimmed.slice(0, 200); // Limit length
            }
          }
        }
      }
      return undefined;
    };

    // Helper function to build function signature
    const buildSignature = (
      params: string[],
      paramTypes: string[],
      returnType: string,
      isAsync: boolean
    ): string => {
      const paramParts = params.map((name, i) => {
        const type = paramTypes[i] || 'any';
        // Handle rest params
        if (name.startsWith('...')) {
          return `${name}: ${type}`;
        }
        // Handle optional params (with ?)
        if (name.endsWith('?')) {
          return `${name}: ${type}`;
        }
        return `${name}: ${type}`;
      });

      const paramsStr = `(${paramParts.join(', ')})`;
      const retStr = isAsync && !returnType.startsWith('Promise')
        ? `Promise<${returnType}>`
        : returnType;

      return `${paramsStr} => ${retStr}`;
    };

    return {
      // Regular function declarations
      FunctionDeclaration: (path: NodePath) => {
        const node = path.node as FunctionDeclaration;
        if (!node.id) return; // Skip anonymous function declarations

        const isAsync = node.async || false;

        // Generate ID using centralized IdGenerator
        const idGenerator = new IdGenerator(scopeTracker);
        const functionId = idGenerator.generateSimple('FUNCTION', node.id.name, module.file, node.loc!.start.line);

        // Extract type info
        const { names: paramNames, types: paramTypes } = extractParamInfo(node.params);
        const returnType = extractReturnType(node);
        const jsdocSummary = extractJsdocSummary(node);
        const signature = buildSignature(paramNames, paramTypes, returnType, isAsync);

        (functions as FunctionInfo[]).push({
          id: functionId,
          type: 'FUNCTION',
          name: node.id.name,
          file: module.file,
          line: node.loc!.start.line,
          async: isAsync,
          generator: node.generator || false,
          params: paramNames,
          paramTypes,
          returnType,
          signature,
          jsdocSummary
        });

        // Enter function scope BEFORE creating parameters (semantic IDs need function context)
        scopeTracker.enterScope(node.id.name, 'FUNCTION');

        // Create PARAMETER nodes for function parameters
        createParameterNodes(node.params, functionId, module.file, node.loc!.start.line, parameters as ParameterInfo[], scopeTracker);

        // Create SCOPE for function body
        const functionBodyScopeId = idGenerator.generateScope('body', `${node.id.name}:body`, module.file, node.loc!.start.line);
        (scopes as ScopeInfo[]).push({
          id: functionBodyScopeId,
          type: 'SCOPE',
          scopeType: 'function_body',
          name: `${node.id.name}:body`,
          conditional: false,
          file: module.file,
          line: node.loc!.start.line,
          parentFunctionId: functionId
        });

        // Analyze function body
        analyzeFunctionBody(path as NodePath<FunctionDeclaration>, functionBodyScopeId, module, collections);

        // Exit function scope
        scopeTracker.exitScope();

        // Stop traversal - analyzeFunctionBody already processed contents
        path.skip();
      },

      // Arrow functions (module-level, assigned to variables or as callbacks)
      ArrowFunctionExpression: (path: NodePath) => {
        const node = path.node as ArrowFunctionExpression;
        const line = node.loc!.start.line;
        const column = node.loc!.start.column;
        const isAsync = node.async || false;

        // Determine arrow function name (use scope-level counter for stable semanticId)
        let functionName = generateAnonymousName();

        // If arrow function is assigned to variable: const add = () => {}
        const parent = path.parent;
        if (parent.type === 'VariableDeclarator') {
          const declarator = parent as VariableDeclarator;
          if (declarator.id.type === 'Identifier') {
            functionName = declarator.id.name;
          }
        }

        // Generate ID using centralized IdGenerator
        const idGenerator = new IdGenerator(scopeTracker);
        const functionId = idGenerator.generate('FUNCTION', functionName, module.file, line, column, functionCounterRef);

        // Extract type info
        const { names: paramNames, types: paramTypes } = extractParamInfo(node.params);
        const returnType = extractReturnType(node);
        const jsdocSummary = extractJsdocSummary(node);
        const signature = buildSignature(paramNames, paramTypes, returnType, isAsync);

        (functions as FunctionInfo[]).push({
          id: functionId,
          type: 'FUNCTION',
          name: functionName,
          file: module.file,
          line,
          column,
          async: isAsync,
          arrowFunction: true,
          params: paramNames,
          paramTypes,
          returnType,
          signature,
          jsdocSummary
        });

        // Enter function scope BEFORE creating parameters (semantic IDs need function context)
        scopeTracker.enterScope(functionName, 'FUNCTION');

        // Create PARAMETER nodes for arrow function parameters
        createParameterNodes(node.params, functionId, module.file, line, parameters as ParameterInfo[], scopeTracker);

        // Create SCOPE for arrow function body
        const bodyScope = idGenerator.generateScope('body', `${functionName}:body`, module.file, line, column);
        (scopes as ScopeInfo[]).push({
          id: bodyScope,
          type: 'SCOPE',
          name: `${functionName}:body`,
          file: module.file,
          line,
          scopeType: 'function-body',
          parentFunctionId: functionId
        });

        analyzeFunctionBody(path as NodePath<ArrowFunctionExpression>, bodyScope, module, collections);

        // Exit function scope
        scopeTracker.exitScope();
      }
    };
  }
}
