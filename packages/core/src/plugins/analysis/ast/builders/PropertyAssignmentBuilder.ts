/**
 * PropertyAssignmentBuilder - creates PROPERTY_ASSIGNMENT nodes and edges.
 *
 * For each 'this.x = value' inside a class method/constructor, creates:
 * - PROPERTY_ASSIGNMENT node (name=property, objectName='this')
 * - CLASS --CONTAINS--> PROPERTY_ASSIGNMENT edge
 * - PROPERTY_ASSIGNMENT --ASSIGNED_FROM--> <rhs node> edge (if rhs is a VARIABLE/PARAMETER/CALL)
 *
 * REG-554
 */
import type {
  ModuleNode,
  ASTCollections,
  PropertyAssignmentInfo,
  VariableDeclarationInfo,
  ParameterInfo,
  ClassDeclarationInfo,
  CallSiteInfo,
  MethodCallInfo,
} from '../types.js';
import type { BuilderContext, DomainBuilder } from './types.js';

export class PropertyAssignmentBuilder implements DomainBuilder {
  constructor(private ctx: BuilderContext) {}

  buffer(module: ModuleNode, data: ASTCollections): void {
    const {
      propertyAssignments = [],
      variableDeclarations = [],
      parameters = [],
      classDeclarations = [],
      callSites = [],
      methodCalls = [],
    } = data;

    this.bufferPropertyAssignments(
      module,
      propertyAssignments,
      variableDeclarations,
      parameters,
      classDeclarations,
      callSites,
      methodCalls
    );
  }

  private bufferPropertyAssignments(
    module: ModuleNode,
    propertyAssignments: PropertyAssignmentInfo[],
    variableDeclarations: VariableDeclarationInfo[],
    parameters: ParameterInfo[],
    classDeclarations: ClassDeclarationInfo[],
    _callSites: CallSiteInfo[],
    _methodCalls: MethodCallInfo[]
  ): void {
    for (const pa of propertyAssignments) {
      // Buffer PROPERTY_ASSIGNMENT node
      this.ctx.bufferNode({
        id: pa.id,
        type: 'PROPERTY_ASSIGNMENT',
        name: pa.propertyName,
        objectName: pa.objectName,
        className: pa.enclosingClassName,
        file: pa.file,
        line: pa.line,
        column: pa.column,
        semanticId: pa.semanticId,
      });

      // CLASS --CONTAINS--> PROPERTY_ASSIGNMENT
      if (pa.enclosingClassName) {
        const classDecl = classDeclarations.find(c =>
          c.name === pa.enclosingClassName && c.file === pa.file
        );
        if (classDecl) {
          this.ctx.bufferEdge({
            type: 'CONTAINS',
            src: classDecl.id,
            dst: pa.id
          });
        }
      }

      // PROPERTY_ASSIGNMENT --ASSIGNED_FROM--> <rhs node>
      const scopePath = pa.scopePath ?? [];
      let sourceNodeId: string | null = null;

      if (pa.valueType === 'VARIABLE' && pa.valueName) {
        // Scope-chain lookup: variable first, then parameter
        const sourceVar = this.ctx.resolveVariableInScope(
          pa.valueName, scopePath, pa.file, variableDeclarations
        );
        const sourceParam = !sourceVar
          ? this.ctx.resolveParameterInScope(pa.valueName, scopePath, pa.file, parameters)
          : null;
        sourceNodeId = sourceVar?.id ?? sourceParam?.id ?? null;
      }
      // CALL, LITERAL, EXPRESSION, OBJECT_LITERAL, ARRAY_LITERAL: no ASSIGNED_FROM edge

      if (sourceNodeId) {
        this.ctx.bufferEdge({
          type: 'ASSIGNED_FROM',
          src: pa.id,
          dst: sourceNodeId
        });
      }
    }
  }
}
