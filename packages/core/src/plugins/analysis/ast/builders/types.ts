/**
 * Shared types for domain-specific graph builders.
 *
 * Each builder buffers nodes/edges for a specific domain (core, control flow,
 * data flow, etc.) using the BuilderContext for shared operations.
 */

import type {
  ModuleNode,
  FunctionInfo,
  VariableDeclarationInfo,
  ParameterInfo,
  ASTCollections,
  GraphNode,
  GraphEdge,
} from '../types.js';

/**
 * Shared context passed to all domain builders.
 * Provides access to buffers, singleton tracking, and scope resolution utilities.
 */
export interface BuilderContext {
  // Buffering operations
  bufferNode(node: GraphNode): void;
  bufferEdge(edge: GraphEdge): void;

  // Singleton tracking (for net:stdio, net:request, EXTERNAL_MODULE, etc.)
  isCreated(singletonKey: string): boolean;
  markCreated(singletonKey: string): void;

  // Buffered node lookup (for metadata updates, e.g., rejection patterns)
  findBufferedNode(id: string): GraphNode | undefined;

  // Scope-aware variable/parameter resolution (REG-309)
  findFunctionByName(
    functions: FunctionInfo[],
    name: string | undefined,
    file: string,
    callScopeId: string
  ): FunctionInfo | undefined;

  resolveVariableInScope(
    name: string,
    scopePath: string[],
    file: string,
    variables: VariableDeclarationInfo[]
  ): VariableDeclarationInfo | null;

  resolveParameterInScope(
    name: string,
    scopePath: string[],
    file: string,
    parameters: ParameterInfo[]
  ): ParameterInfo | null;

  scopePathsMatch(a: string[], b: string[]): boolean;
}

/**
 * Interface for domain-specific graph builders.
 * Each builder is responsible for buffering nodes/edges for one domain.
 */
export interface DomainBuilder {
  buffer(module: ModuleNode, data: ASTCollections): void;
}
