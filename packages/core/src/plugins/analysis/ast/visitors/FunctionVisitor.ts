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
  FunctionExpression,
  StaticBlock,
  Identifier,
  AssignmentPattern,
  RestElement,
  VariableDeclarator,
  Comment,
  NewExpression
} from '@babel/types';
import type { NodePath } from '@babel/traverse';
import { ASTVisitor, type VisitorModule, type VisitorCollections, type VisitorHandlers } from './ASTVisitor.js';
import { typeNodeToString, extractTypeParameters } from './TypeScriptVisitor.js';
import type { ScopeTracker } from '../../../../core/ScopeTracker.js';
import { IdGenerator } from '../IdGenerator.js';
import { createParameterNodes } from '../utils/createParameterNodes.js';
import { getLine, getColumn } from '../utils/location.js';
import type { ParameterInfo, PromiseExecutorContext, TypeParameterInfo } from '../types.js';
import { ConstructorCallNode } from '../../../../core/nodes/ConstructorCallNode.js';

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
  start?: number;  // Byte offset in file for positional linking
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
 * REG-271: Widened to include StaticBlock for class static initialization blocks
 */
export type AnalyzeFunctionBodyCallback = (
  path: NodePath<Function | StaticBlock>,
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

        const line = getLine(node);

        // Generate ID using centralized IdGenerator
        const idGenerator = new IdGenerator(scopeTracker);
        const functionId = idGenerator.generateV2Simple('FUNCTION', node.id.name, module.file);

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
          line,
          async: isAsync,
          generator: node.generator || false,
          params: paramNames,
          paramTypes,
          returnType,
          signature,
          jsdocSummary,
          start: node.start ?? undefined
        });

        // Extract type parameters (REG-303)
        const typeParametersCollection = collections.typeParameters;
        if (typeParametersCollection && (node as any).typeParameters) {
          const typeParamInfos = extractTypeParameters(
            (node as any).typeParameters,
            functionId,
            'FUNCTION',
            module.file,
            line,
            getColumn(node)
          );
          for (const tp of typeParamInfos) {
            (typeParametersCollection as TypeParameterInfo[]).push(tp);
          }
        }

        // Enter function scope BEFORE creating parameters (semantic IDs need function context)
        scopeTracker.enterScope(node.id.name, 'FUNCTION');

        // Create PARAMETER nodes for function parameters
        createParameterNodes(node.params, functionId, module.file, getLine(node), parameters as ParameterInfo[], scopeTracker);

        // Create SCOPE for function body
        const functionBodyScopeId = idGenerator.generateV2Simple('SCOPE', 'body', module.file);
        (scopes as ScopeInfo[]).push({
          id: functionBodyScopeId,
          type: 'SCOPE',
          scopeType: 'function_body',
          name: `${node.id.name}:body`,
          conditional: false,
          file: module.file,
          line,
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
        // Skip arrow functions nested inside other functions — those are handled
        // by NestedFunctionHandler during analyzeFunctionBody traversal.
        const functionParent = path.getFunctionParent();
        if (functionParent) return;

        // Skip arrow functions used as class field initializers — ClassVisitor is authoritative (REG-562)
        const parent = path.parent;
        if (parent.type === 'ClassProperty' || parent.type === 'ClassPrivateProperty') return;

        const node = path.node as ArrowFunctionExpression;
        const line = getLine(node);
        const column = getColumn(node);
        const isAsync = node.async || false;

        // Determine arrow function name (use scope-level counter for stable semanticId)
        let functionName = generateAnonymousName();

        // If arrow function is assigned to variable: const add = () => {}
        if (parent.type === 'VariableDeclarator') {
          const declarator = parent as VariableDeclarator;
          if (declarator.id.type === 'Identifier') {
            functionName = declarator.id.name;
          }
        }

        // Generate ID using centralized IdGenerator
        const idGenerator = new IdGenerator(scopeTracker);
        const functionId = idGenerator.generateV2Simple('FUNCTION', functionName, module.file);

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
          jsdocSummary,
          start: node.start ?? undefined
        });

        // Extract type parameters (REG-303)
        const arrowTypeParamsCollection = collections.typeParameters;
        if (arrowTypeParamsCollection && (node as any).typeParameters) {
          const typeParamInfos = extractTypeParameters(
            (node as any).typeParameters,
            functionId,
            'FUNCTION',
            module.file,
            line,
            column
          );
          for (const tp of typeParamInfos) {
            (arrowTypeParamsCollection as TypeParameterInfo[]).push(tp);
          }
        }

        // Enter function scope BEFORE creating parameters (semantic IDs need function context)
        scopeTracker.enterScope(functionName, 'FUNCTION');

        // Create PARAMETER nodes for arrow function parameters
        createParameterNodes(node.params, functionId, module.file, line, parameters as ParameterInfo[], scopeTracker);

        // Create SCOPE for arrow function body
        const bodyScope = idGenerator.generateV2Simple('SCOPE', 'body', module.file);
        (scopes as ScopeInfo[]).push({
          id: bodyScope,
          type: 'SCOPE',
          name: `${functionName}:body`,
          file: module.file,
          line,
          scopeType: 'function-body',
          parentFunctionId: functionId
        });

        // REG-334: Detect Promise executor context BEFORE analyzing body
        // This must happen before analyzeFunctionBody so resolve/reject calls can be linked
        this.detectPromiseExecutorContext(path, node, module, collections);

        analyzeFunctionBody(path as NodePath<ArrowFunctionExpression>, bodyScope, module, collections);

        // Exit function scope
        scopeTracker.exitScope();

        // Stop traversal - analyzeFunctionBody already processed contents
        // Without this, babel traverse continues into arrow body and finds
        // nested arrow functions, causing duplicate FUNCTION nodes
        path.skip();
      }
    };
  }

  /**
   * REG-334: Detect if this function is a Promise executor callback.
   * If so, register the context so resolve/reject calls can be linked.
   *
   * Pattern: new Promise((resolve, reject) => { ... })
   *
   * Must be called BEFORE analyzeFunctionBody so the context is available
   * when resolve/reject calls are processed.
   */
  private detectPromiseExecutorContext(
    path: NodePath,
    node: ArrowFunctionExpression | FunctionExpression,
    module: VisitorModule,
    collections: VisitorCollections
  ): void {
    // Check if this function is the first argument to new Promise()
    const parent = path.parent;
    if (parent?.type !== 'NewExpression') return;

    const newExpr = parent as NewExpression;

    // Check it's Promise constructor
    if (newExpr.callee.type !== 'Identifier') return;
    if ((newExpr.callee as Identifier).name !== 'Promise') return;

    // Check this function is the first argument
    if (newExpr.arguments.length === 0) return;
    if (newExpr.arguments[0] !== node) return;

    // Extract resolve/reject parameter names
    let resolveName: string | undefined;
    let rejectName: string | undefined;

    if (node.params.length > 0 && node.params[0].type === 'Identifier') {
      resolveName = (node.params[0] as Identifier).name;
    }
    if (node.params.length > 1 && node.params[1].type === 'Identifier') {
      rejectName = (node.params[1] as Identifier).name;
    }

    if (!resolveName) return; // No resolve parameter, nothing to track

    // Generate the CONSTRUCTOR_CALL ID for linking
    const line = getLine(newExpr);
    const column = getColumn(newExpr);
    const constructorCallId = ConstructorCallNode.generateId('Promise', module.file, line, column);

    // Initialize promiseExecutorContexts if not exists
    if (!collections.promiseExecutorContexts) {
      collections.promiseExecutorContexts = new Map<string, PromiseExecutorContext>();
    }

    // Key by function node position to allow nested Promise detection
    const funcKey = `${node.start}:${node.end}`;
    (collections.promiseExecutorContexts as Map<string, PromiseExecutorContext>).set(funcKey, {
      constructorCallId,
      resolveName,
      rejectName,
      file: module.file,
      line: getLine(node)
    });
  }
}
