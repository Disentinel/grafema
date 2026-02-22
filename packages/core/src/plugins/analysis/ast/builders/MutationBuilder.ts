/**
 * MutationBuilder - buffers FLOWS_INTO edges for array mutations, object mutations,
 * and variable reassignments.
 *
 * Extracted from GraphBuilder: bufferArrayMutationEdges, bufferObjectMutationEdges,
 * bufferVariableReassignmentEdges (REG-422).
 */

import { NodeFactory } from '../../../../core/NodeFactory.js';
import type {
  ModuleNode,
  ASTCollections,
  ArrayMutationInfo,
  ObjectMutationInfo,
  VariableReassignmentInfo,
  VariableDeclarationInfo,
  ParameterInfo,
  LiteralInfo,
  ObjectLiteralInfo,
  ArrayLiteralInfo,
  CallSiteInfo,
  MethodCallInfo,
  FunctionInfo,
  ClassDeclarationInfo,
  GraphEdge,
} from '../types.js';
import type { BuilderContext, DomainBuilder } from './types.js';

export class MutationBuilder implements DomainBuilder {
  constructor(private ctx: BuilderContext) {}

  buffer(module: ModuleNode, data: ASTCollections): void {
    const {
      arrayMutations = [],
      objectMutations = [],
      variableReassignments = [],
      variableDeclarations = [],
      parameters = [],
      literals = [],
      objectLiterals = [],
      arrayLiterals = [],
      callSites = [],
      methodCalls = [],
      functions = [],
      classDeclarations = [],
    } = data;

    this.bufferArrayMutationEdges(
      arrayMutations, variableDeclarations, parameters,
      literals, objectLiterals, arrayLiterals, callSites
    );
    this.bufferObjectMutationEdges(
      objectMutations, variableDeclarations, parameters,
      functions, classDeclarations
    );
    this.bufferVariableReassignmentEdges(
      variableReassignments, variableDeclarations, callSites,
      methodCalls, parameters
    );
  }

  /**
   * Buffer FLOWS_INTO edges for array mutations (push, unshift, splice, indexed assignment)
   * Creates edges from inserted values to the array variable.
   *
   * REG-117: Handles nested mutations like obj.arr.push(item)
   * REG-392: Handles non-variable values (LITERAL, OBJECT_LITERAL, ARRAY_LITERAL, CALL)
   */
  private bufferArrayMutationEdges(
    arrayMutations: ArrayMutationInfo[],
    variableDeclarations: VariableDeclarationInfo[],
    parameters: ParameterInfo[],
    literals: LiteralInfo[],
    objectLiterals: ObjectLiteralInfo[],
    arrayLiterals: ArrayLiteralInfo[],
    callSites: CallSiteInfo[]
  ): void {
    for (const mutation of arrayMutations) {
      const { arrayName, mutationScopePath, mutationMethod, insertedValues, file, isNested, baseObjectName, propertyName } = mutation;

      const scopePath = mutationScopePath ?? [];

      // REG-117: For nested mutations (obj.arr.push), resolve target node
      let targetNodeId: string | null = null;
      let nestedProperty: string | undefined;

      if (isNested && baseObjectName) {
        // Skip 'this.items.push' - 'this' is not a variable node
        if (baseObjectName === 'this') continue;

        // Nested mutation: try base object lookup with scope chain (REG-309)
        const baseVar = this.ctx.resolveVariableInScope(baseObjectName, scopePath, file, variableDeclarations);
        const baseParam = !baseVar ? this.ctx.resolveParameterInScope(baseObjectName, scopePath, file, parameters) : null;
        targetNodeId = baseVar?.id ?? baseParam?.id ?? null;
        nestedProperty = propertyName;
      } else {
        // Direct mutation: arr.push() (REG-309)
        const arrayVar = this.ctx.resolveVariableInScope(arrayName, scopePath, file, variableDeclarations);
        const arrayParam = !arrayVar ? this.ctx.resolveParameterInScope(arrayName, scopePath, file, parameters) : null;
        targetNodeId = arrayVar?.id ?? arrayParam?.id ?? null;
      }

      if (!targetNodeId) continue;

      // Create FLOWS_INTO edges for each inserted value
      for (const arg of insertedValues) {
        let sourceNodeId: string | undefined;

        if (arg.valueType === 'VARIABLE' && arg.valueName) {
          // Scope-aware lookup for source variable (REG-309)
          const sourceVar = this.ctx.resolveVariableInScope(arg.valueName, scopePath, file, variableDeclarations);
          const sourceParam = !sourceVar ? this.ctx.resolveParameterInScope(arg.valueName, scopePath, file, parameters) : null;
          sourceNodeId = sourceVar?.id ?? sourceParam?.id;
        } else if (arg.valueNodeId) {
          // REG-392: Direct node ID for indexed assignments (LITERAL, OBJECT_LITERAL, ARRAY_LITERAL)
          sourceNodeId = arg.valueNodeId;
        } else if (arg.valueType === 'LITERAL' && arg.valueLine !== undefined && arg.valueColumn !== undefined) {
          // REG-392: Find LITERAL node by coordinates (push/unshift — nodes created by extractArguments)
          const literalNode = literals.find(l =>
            l.line === arg.valueLine && l.column === arg.valueColumn && l.file === file
          );
          sourceNodeId = literalNode?.id;
        } else if (arg.valueType === 'OBJECT_LITERAL' && arg.valueLine !== undefined && arg.valueColumn !== undefined) {
          // REG-392: Find OBJECT_LITERAL node by coordinates
          const objNode = objectLiterals.find(o =>
            o.line === arg.valueLine && o.column === arg.valueColumn && o.file === file
          );
          sourceNodeId = objNode?.id;
        } else if (arg.valueType === 'ARRAY_LITERAL' && arg.valueLine !== undefined && arg.valueColumn !== undefined) {
          // REG-392: Find ARRAY_LITERAL node by coordinates
          const arrNode = arrayLiterals.find(a =>
            a.line === arg.valueLine && a.column === arg.valueColumn && a.file === file
          );
          sourceNodeId = arrNode?.id;
        } else if (arg.valueType === 'CALL' && arg.callLine !== undefined && arg.callColumn !== undefined) {
          // REG-392: Find CALL_SITE node by coordinates
          const callSite = callSites.find(cs =>
            cs.line === arg.callLine && cs.column === arg.callColumn && cs.file === file
          );
          sourceNodeId = callSite?.id;
        }

        if (sourceNodeId) {
          const edgeData: GraphEdge = {
            type: 'FLOWS_INTO',
            src: sourceNodeId,
            dst: targetNodeId,
            mutationMethod,
            argIndex: arg.argIndex
          };
          if (arg.isSpread) {
            edgeData.isSpread = true;
          }
          if (nestedProperty) {
            edgeData.nestedProperty = nestedProperty;
          }
          this.ctx.bufferEdge(edgeData);
        }
      }
    }
  }

  /**
   * Buffer FLOWS_INTO edges for object mutations (property assignment, Object.assign)
   * Creates edges from source values to the object variable being mutated.
   *
   * REG-152: For 'this.prop = value' patterns inside classes, creates edges
   * to the CLASS node with mutationType: 'this_property'.
   */
  private bufferObjectMutationEdges(
    objectMutations: ObjectMutationInfo[],
    variableDeclarations: VariableDeclarationInfo[],
    parameters: ParameterInfo[],
    functions: FunctionInfo[],
    classDeclarations: ClassDeclarationInfo[]
  ): void {
    for (const mutation of objectMutations) {
      const { objectName, mutationScopePath, propertyName, mutationType, computedPropertyVar, value, file, enclosingClassName, enclosingFunctionName } = mutation;

      const scopePath = mutationScopePath ?? [];

      // Find the target node (object variable, parameter, or class for 'this')
      let objectNodeId: string | null = null;
      let effectiveMutationType: 'property' | 'computed' | 'assign' | 'spread' | 'this_property' = mutationType;

      if (objectName !== 'this') {
        // Regular object - find variable, parameter, or function using scope chain (REG-309)
        const objectVar = this.ctx.resolveVariableInScope(objectName, scopePath, file, variableDeclarations);
        const objectParam = !objectVar ? this.ctx.resolveParameterInScope(objectName, scopePath, file, parameters) : null;
        const objectFunc = !objectVar && !objectParam ? functions.find(f => f.name === objectName && f.file === file) : null;
        objectNodeId = objectVar?.id ?? objectParam?.id ?? objectFunc?.id ?? null;
        if (!objectNodeId) continue;
      } else {
        // REG-152: 'this' mutations - find the CLASS node (or constructor FUNCTION for REG-557)
        if (!enclosingClassName) continue;  // Skip if no class context (e.g., standalone function)

        // REG-557: Constructor this.prop = value flows to constructor FUNCTION node
        if (enclosingFunctionName === 'constructor') {
          const constructorFn = functions.find(f => f.isClassMethod && f.className === enclosingClassName && f.name === 'constructor' && f.file === file);
          objectNodeId = constructorFn?.id ?? null;
        }

        // For non-constructor methods, or if constructor FUNCTION not found, use CLASS node
        if (!objectNodeId) {
          const classDecl = classDeclarations.find(c => c.name === enclosingClassName && c.file === file);
          objectNodeId = classDecl?.id ?? null;
        }

        if (!objectNodeId) continue;  // Skip if class not found

        // Use special mutation type to distinguish from regular property mutations
        effectiveMutationType = 'this_property';
      }

      // Create FLOWS_INTO edge for VARIABLE value type
      if (value.valueType === 'VARIABLE' && value.valueName) {
        // Find the source: can be variable, parameter, or function using scope chain (REG-309)
        const sourceVar = this.ctx.resolveVariableInScope(value.valueName, scopePath, file, variableDeclarations);
        const sourceParam = !sourceVar ? this.ctx.resolveParameterInScope(value.valueName, scopePath, file, parameters) : null;
        const sourceFunc = !sourceVar && !sourceParam ? functions.find(f => f.name === value.valueName && f.file === file) : null;
        const sourceNodeId = sourceVar?.id ?? sourceParam?.id ?? sourceFunc?.id;

        if (sourceNodeId && objectNodeId) {
          const edgeData: GraphEdge = {
            type: 'FLOWS_INTO',
            src: sourceNodeId,
            dst: objectNodeId,
            mutationType: effectiveMutationType,
            propertyName,
            computedPropertyVar  // For enrichment phase resolution
          };
          if (value.argIndex !== undefined) {
            edgeData.argIndex = value.argIndex;
          }
          if (value.isSpread) {
            edgeData.isSpread = true;
          }
          this.ctx.bufferEdge(edgeData);
        }
      }
      // For literals, object literals, etc. - we just track variable -> object flows for now
    }
  }

  /**
   * Buffer FLOWS_INTO edges for variable reassignments.
   * Handles: x = y, x += y (when x is already declared, not initialization)
   *
   * Edge patterns:
   * - Simple assignment (=): source --FLOWS_INTO--> variable
   * - Compound operators (+=, -=, etc.):
   *   - source --FLOWS_INTO--> variable (write new value)
   *   - variable --READS_FROM--> variable (self-loop: reads current value before write)
   *
   * REG-309: Uses scope-aware variable lookup via resolveVariableInScope().
   *
   * REG-290: Complete implementation with inline node creation (no continue statements).
   */
  private bufferVariableReassignmentEdges(
    variableReassignments: VariableReassignmentInfo[],
    variableDeclarations: VariableDeclarationInfo[],
    callSites: CallSiteInfo[],
    methodCalls: MethodCallInfo[],
    parameters: ParameterInfo[]
  ): void {
    // Note: No longer using Map-based cache - scope-aware lookup requires scope chain walk
    // Performance: O(n*m*s) where s = scope depth (typically 2-3), acceptable for correctness

    for (const reassignment of variableReassignments) {
      const {
        variableName,
        mutationScopePath,
        valueType,
        valueName,
        valueId,
        callLine,
        callColumn,
        operator,
        literalValue,
        expressionType,
        expressionMetadata,
        file,
        line,
        column
      } = reassignment;

      // Find target variable node using scope chain resolution (REG-309)
      const scopePath = mutationScopePath ?? [];
      const targetVar = this.ctx.resolveVariableInScope(variableName, scopePath, file, variableDeclarations);
      const targetParam = !targetVar ? this.ctx.resolveParameterInScope(variableName, scopePath, file, parameters) : null;
      const targetNodeId = targetVar?.id ?? targetParam?.id;

      if (!targetNodeId) {
        // Variable not found - could be external reference
        continue;
      }

      // Resolve source node based on value type
      let sourceNodeId: string | null = null;

      // LITERAL: Create node inline (NO CONTINUE STATEMENT)
      if (valueType === 'LITERAL' && valueId) {
        // Create LITERAL node
        this.ctx.bufferNode({
          type: 'LITERAL',
          id: valueId,
          value: literalValue,
          file,
          line,
          column
        });
        sourceNodeId = valueId;
      }
      // VARIABLE: Look up existing variable/parameter node using scope chain (REG-309)
      else if (valueType === 'VARIABLE' && valueName) {
        const sourceVar = this.ctx.resolveVariableInScope(valueName, scopePath, file, variableDeclarations);
        const sourceParam = !sourceVar ? this.ctx.resolveParameterInScope(valueName, scopePath, file, parameters) : null;
        sourceNodeId = sourceVar?.id ?? sourceParam?.id ?? null;
      }
      // CALL_SITE: Look up existing call node
      else if (valueType === 'CALL_SITE' && callLine && callColumn) {
        const callSite = callSites.find(cs =>
          cs.line === callLine && cs.column === callColumn && cs.file === file
        );
        sourceNodeId = callSite?.id ?? null;
      }
      // METHOD_CALL: Look up existing method call node
      else if (valueType === 'METHOD_CALL' && callLine && callColumn) {
        const methodCall = methodCalls.find(mc =>
          mc.line === callLine && mc.column === callColumn && mc.file === file
        );
        sourceNodeId = methodCall?.id ?? null;
      }
      // EXPRESSION: Create node inline (NO CONTINUE STATEMENT)
      else if (valueType === 'EXPRESSION' && valueId && expressionType) {
        // Create EXPRESSION node using NodeFactory
        const expressionNode = NodeFactory.createExpressionFromMetadata(
          expressionType,
          file,
          line,
          column,
          {
            id: valueId,  // ID from JSASTAnalyzer
            object: expressionMetadata?.object,
            property: expressionMetadata?.property,
            computed: expressionMetadata?.computed,
            computedPropertyVar: expressionMetadata?.computedPropertyVar ?? undefined,
            operator: expressionMetadata?.operator
          }
        );

        this.ctx.bufferNode(expressionNode);
        sourceNodeId = valueId;
      }

      // Create edges if source found
      if (sourceNodeId && targetNodeId) {
        // For compound operators (operator !== '='), LHS reads its own current value
        // Create READS_FROM self-loop (Linus requirement)
        if (operator !== '=') {
          this.ctx.bufferEdge({
            type: 'READS_FROM',
            src: targetNodeId,  // Variable reads from...
            dst: targetNodeId   // ...itself (self-loop)
          });
        }

        // RHS flows into LHS (write side)
        this.ctx.bufferEdge({
          type: 'FLOWS_INTO',
          src: sourceNodeId,
          dst: targetNodeId
        });
      }
    }
  }
}
