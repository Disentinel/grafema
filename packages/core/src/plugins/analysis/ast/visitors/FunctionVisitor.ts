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
  VariableDeclarator
} from '@babel/types';
import type { NodePath } from '@babel/traverse';
import { ASTVisitor, type VisitorModule, type VisitorCollections, type VisitorHandlers, type CounterRef } from './ASTVisitor.js';

/**
 * Scope context for generating stable semantic IDs
 */
interface ScopeContext {
  semanticPath: string;
  siblingCounters: Map<string, number>;
}

/**
 * Parameter node info
 */
interface ParameterInfo {
  id: string;
  type: 'PARAMETER';
  name: string;
  file: string;
  line: number;
  index: number;
  hasDefault?: boolean;
  isRest?: boolean;
  parentFunctionId: string;
}

/**
 * Function node info
 */
interface FunctionInfo {
  id: string;
  stableId: string;
  type: 'FUNCTION';
  name: string;
  file: string;
  line: number;
  column?: number;
  async: boolean;
  generator?: boolean;
  arrowFunction?: boolean;
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

  /**
   * @param module - Current module being analyzed
   * @param collections - Must contain arrays and counter refs
   * @param analyzeFunctionBody - Callback to analyze function internals
   */
  constructor(
    module: VisitorModule,
    collections: VisitorCollections,
    analyzeFunctionBody: AnalyzeFunctionBodyCallback
  ) {
    super(module, collections);
    this.analyzeFunctionBody = analyzeFunctionBody;
  }

  getHandlers(): VisitorHandlers {
    const { module } = this;
    const functions = this.collections.functions ?? [];
    const parameters = this.collections.parameters ?? [];
    const scopes = this.collections.scopes ?? [];
    const functionCounterRef = (this.collections.functionCounterRef ?? { value: 0 }) as CounterRef;
    const moduleScopeCtx = this.collections.moduleScopeCtx as ScopeContext | undefined;

    const analyzeFunctionBody = this.analyzeFunctionBody;
    const collections = this.collections;

    // Helper function to generate stable anonymous function name
    const generateAnonymousName = (): string => {
      if (!moduleScopeCtx) return 'anonymous';
      const index = moduleScopeCtx.siblingCounters.get('anonymous') || 0;
      moduleScopeCtx.siblingCounters.set('anonymous', index + 1);
      return `anonymous[${index}]`;
    };

    // Helper function to create PARAMETER nodes for function params
    const createParameterNodes = (
      params: Node[],
      functionId: string,
      file: string,
      line: number
    ): void => {
      if (!parameters) return; // Guard for backward compatibility

      params.forEach((param, index) => {
        // Handle different parameter types
        if (param.type === 'Identifier') {
          const paramId = `PARAMETER#${param.name}#${file}#${line}:${index}`;
          (parameters as ParameterInfo[]).push({
            id: paramId,
            type: 'PARAMETER',
            name: param.name,
            file: file,
            line: param.loc?.start.line || line,
            index: index,
            parentFunctionId: functionId
          });
        } else if (param.type === 'AssignmentPattern') {
          // Default parameter: function(a = 1)
          const assignmentParam = param as AssignmentPattern;
          if (assignmentParam.left.type === 'Identifier') {
            const paramId = `PARAMETER#${assignmentParam.left.name}#${file}#${line}:${index}`;
            (parameters as ParameterInfo[]).push({
              id: paramId,
              type: 'PARAMETER',
              name: assignmentParam.left.name,
              file: file,
              line: assignmentParam.left.loc?.start.line || line,
              index: index,
              hasDefault: true,
              parentFunctionId: functionId
            });
          }
        } else if ((param as Node).type === 'RestElement') {
          // Rest parameter: function(...args)
          const restParam = param as unknown as RestElement;
          if (restParam.argument.type === 'Identifier') {
            const paramId = `PARAMETER#${restParam.argument.name}#${file}#${line}:${index}`;
            (parameters as ParameterInfo[]).push({
              id: paramId,
              type: 'PARAMETER',
              name: restParam.argument.name,
              file: file,
              line: restParam.argument.loc?.start.line || line,
              index: index,
              isRest: true,
              parentFunctionId: functionId
            });
          }
        }
        // ObjectPattern and ArrayPattern (destructuring parameters) can be added later
      });
    };

    return {
      // Regular function declarations
      FunctionDeclaration: (path: NodePath) => {
        const node = path.node as FunctionDeclaration;
        if (!node.id) return; // Skip anonymous function declarations

        const functionId = `FUNCTION#${node.id.name}#${module.file}#${node.loc!.start.line}`;

        (functions as FunctionInfo[]).push({
          id: functionId,
          stableId: functionId,
          type: 'FUNCTION',
          name: node.id.name,
          file: module.file,
          line: node.loc!.start.line,
          async: node.async || false,
          generator: node.generator || false
        });

        // Create PARAMETER nodes for function parameters
        createParameterNodes(node.params, functionId, module.file, node.loc!.start.line);

        // Create SCOPE for function body
        const functionBodyScopeId = `SCOPE#${node.id.name}:body#${module.file}#${node.loc!.start.line}`;
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

        // Stop traversal - analyzeFunctionBody already processed contents
        path.skip();
      },

      // Arrow functions (module-level, assigned to variables or as callbacks)
      ArrowFunctionExpression: (path: NodePath) => {
        const node = path.node as ArrowFunctionExpression;
        const line = node.loc!.start.line;
        const column = node.loc!.start.column;

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

        const functionId = `FUNCTION#${functionName}#${module.file}#${line}:${column}:${functionCounterRef.value++}`;

        (functions as FunctionInfo[]).push({
          id: functionId,
          stableId: functionId,
          type: 'FUNCTION',
          name: functionName,
          file: module.file,
          line,
          column,
          async: node.async || false,
          arrowFunction: true
        });

        // Create PARAMETER nodes for arrow function parameters
        createParameterNodes(node.params, functionId, module.file, line);

        // Create SCOPE for arrow function body
        const bodyScope = `SCOPE#${functionName}:body#${module.file}#${line}:${column}`;
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
      }
    };
  }
}
