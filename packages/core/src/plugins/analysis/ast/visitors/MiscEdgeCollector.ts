/**
 * MiscEdgeCollector - single-pass visitor that collects self-contained edge data.
 * "Self-contained" = both src and dst nodes are created by this collector.
 *
 * Self-contained edges:
 * - UNION_MEMBER, INTERSECTS_WITH, INFERS
 * - SPREADS_FROM, DELETES, SHADOWS, MERGES_WITH, ACCESSES_PRIVATE
 *
 * Collection-derived edges are handled by MiscEdgeBuilder using existing collection data.
 */

import type { NodePath } from '@babel/traverse';
import type * as t from '@babel/types';
import type { MiscEdgeInfo, MiscNodeInfo } from '../types.js';
import type { ScopeTracker } from '../../../../core/ScopeTracker.js';
import { typeNodeToString } from './TypeScriptVisitor.js';

interface CollectorContext {
  file: string;
  moduleId: string;
  miscEdges: MiscEdgeInfo[];
  miscNodes: MiscNodeInfo[];
  scopeTracker?: ScopeTracker;
  typeNodeCounter: number;
  // Track existing node IDs for referencing
  functionIds: Map<string, string>;     // "name:line:col" -> functionId
  parameterIds: Map<string, string>;    // "name:funcLine" -> parameterId
  variableIds: Map<string, string>;     // "name:line" -> variableId
  callIds: Map<string, string>;         // "line:col" -> callId
}

/**
 * Create a typed TYPE node ID.
 */
function makeTypeNodeId(file: string, name: string, line: number, col: number, counter: number): string {
  return `TYPE#${name}#${file}#${line}:${col}:${counter}`;
}

export function createMiscEdgeHandlers(ctx: CollectorContext) {
  const { file, miscEdges, miscNodes } = ctx;

  return {
    // SPREADS_FROM: ...expr spread syntax (self-contained with EXPRESSION nodes)
    SpreadElement(path: NodePath<t.SpreadElement>) {
      const node = path.node;
      const arg = node.argument;
      if (!arg) return;

      const line = node.loc?.start.line ?? 0;
      const col = node.loc?.start.column ?? 0;
      const argLine = arg.loc?.start.line ?? line;
      const argCol = arg.loc?.start.column ?? col;

      const spreadId = `misc:EXPRESSION:spread#${file}#${line}:${col}:${ctx.typeNodeCounter++}`;
      miscNodes.push({
        id: spreadId,
        type: 'EXPRESSION',
        name: 'spread',
        file,
        line,
        column: col,
      });

      let targetName = 'unknown';
      if (arg.type === 'Identifier') targetName = arg.name;
      else if (arg.type === 'CallExpression' && arg.callee.type === 'Identifier') targetName = `${arg.callee.name}()`;

      const targetId = `misc:EXPRESSION:spread-source:${targetName}#${file}#${argLine}:${argCol}:${ctx.typeNodeCounter++}`;
      miscNodes.push({
        id: targetId,
        type: 'EXPRESSION',
        name: targetName,
        file,
        line: argLine,
        column: argCol,
      });

      miscEdges.push({
        edgeType: 'SPREADS_FROM',
        srcId: spreadId,
        dstId: targetId,
      });
    },

    // DELETES: delete obj.prop (self-contained with EXPRESSION nodes)
    UnaryExpression(path: NodePath<t.UnaryExpression>) {
      const node = path.node;
      if (node.operator !== 'delete') return;

      const arg = node.argument;
      const line = node.loc?.start.line ?? 0;
      const col = node.loc?.start.column ?? 0;

      const deleteId = `misc:EXPRESSION:delete#${file}#${line}:${col}:${ctx.typeNodeCounter++}`;
      miscNodes.push({
        id: deleteId,
        type: 'EXPRESSION',
        name: 'delete',
        file,
        line,
        column: col,
      });

      let targetName = 'unknown';
      if (arg.type === 'MemberExpression') {
        const objName = arg.object.type === 'Identifier' ? arg.object.name : 'obj';
        const propName = arg.property.type === 'Identifier' ? arg.property.name :
          arg.property.type === 'StringLiteral' ? arg.property.value : 'prop';
        targetName = `${objName}.${propName}`;
      }

      const targetId = `misc:EXPRESSION:delete-target:${targetName}#${file}#${line}:${col}:${ctx.typeNodeCounter++}`;
      miscNodes.push({
        id: targetId,
        type: 'EXPRESSION',
        name: targetName,
        file,
        line,
        column: col,
      });

      miscEdges.push({
        edgeType: 'DELETES',
        srcId: deleteId,
        dstId: targetId,
      });
    },

    // ACCESSES_PRIVATE: private field/method access via #name
    MemberExpression(path: NodePath<t.MemberExpression>) {
      const node = path.node;
      if (node.property.type !== 'PrivateName') return;

      const line = node.loc?.start.line ?? 0;
      const col = node.loc?.start.column ?? 0;
      const privateName = node.property.id.name;

      const accessId = `misc:EXPRESSION:private-access:${privateName}#${file}#${line}:${col}:${ctx.typeNodeCounter++}`;
      miscNodes.push({
        id: accessId,
        type: 'EXPRESSION',
        name: `#${privateName}`,
        file,
        line,
        column: col,
      });

      const targetId = `misc:EXPRESSION:private-field:${privateName}#${file}#${line}:${col}:${ctx.typeNodeCounter++}`;
      miscNodes.push({
        id: targetId,
        type: 'EXPRESSION',
        name: privateName,
        file,
        line,
        column: col,
      });

      miscEdges.push({
        edgeType: 'ACCESSES_PRIVATE',
        srcId: accessId,
        dstId: targetId,
      });
    },

    // SHADOWS: variable in inner scope shadows same-named variable in outer scope
    // Detect by tracking variable bindings per scope level
    'FunctionDeclaration|FunctionExpression|ArrowFunctionExpression'(path: NodePath) {
      const funcNode = path.node as t.FunctionDeclaration | t.FunctionExpression | t.ArrowFunctionExpression;
      const _scopeKey = `${path.node.loc?.start.line}:${path.node.loc?.start.column}`;

      // Collect parameters
      const innerVars = new Map<string, { line: number; col: number }>();
      for (const param of funcNode.params) {
        if (param.type === 'Identifier') {
          innerVars.set(param.name, {
            line: param.loc?.start.line ?? 0,
            col: param.loc?.start.column ?? 0,
          });
        }
      }

      // Check if any inner variable shadows an outer one
      const outerBindings = path.scope.parent?.bindings ?? {};
      for (const [name, pos] of innerVars) {
        if (name in outerBindings) {
          const outerLine = outerBindings[name].identifier?.loc?.start.line ?? 0;
          const outerCol = outerBindings[name].identifier?.loc?.start.column ?? 0;

          const innerId = `misc:EXPRESSION:shadow-inner:${name}#${file}#${pos.line}:${pos.col}:${ctx.typeNodeCounter++}`;
          const outerId = `misc:EXPRESSION:shadow-outer:${name}#${file}#${outerLine}:${outerCol}:${ctx.typeNodeCounter++}`;

          miscNodes.push({
            id: innerId,
            type: 'EXPRESSION',
            name: `${name}(inner)`,
            file,
            line: pos.line,
            column: pos.col,
          });
          miscNodes.push({
            id: outerId,
            type: 'EXPRESSION',
            name: `${name}(outer)`,
            file,
            line: outerLine,
            column: outerCol,
          });

          miscEdges.push({
            edgeType: 'SHADOWS',
            srcId: innerId,
            dstId: outerId,
          });
        }
      }
    },

    // MERGES_WITH: Object.assign(target, source) or { ...a, ...b } object spread
    ObjectExpression(path: NodePath<t.ObjectExpression>) {
      const node = path.node;
      const spreads: { name: string; line: number; col: number }[] = [];

      for (const prop of node.properties) {
        if (prop.type === 'SpreadElement' && prop.argument.type === 'Identifier') {
          spreads.push({
            name: prop.argument.name,
            line: prop.loc?.start.line ?? 0,
            col: prop.loc?.start.column ?? 0,
          });
        }
      }

      // If multiple spreads, they merge with each other
      if (spreads.length >= 2) {
        for (let i = 1; i < spreads.length; i++) {
          const srcSpread = spreads[i];
          const dstSpread = spreads[i - 1];

          const srcId = `misc:EXPRESSION:merge-src:${srcSpread.name}#${file}#${srcSpread.line}:${srcSpread.col}:${ctx.typeNodeCounter++}`;
          const dstId = `misc:EXPRESSION:merge-dst:${dstSpread.name}#${file}#${dstSpread.line}:${dstSpread.col}:${ctx.typeNodeCounter++}`;

          miscNodes.push({
            id: srcId,
            type: 'EXPRESSION',
            name: srcSpread.name,
            file,
            line: srcSpread.line,
            column: srcSpread.col,
          });
          miscNodes.push({
            id: dstId,
            type: 'EXPRESSION',
            name: dstSpread.name,
            file,
            line: dstSpread.line,
            column: dstSpread.col,
          });

          miscEdges.push({
            edgeType: 'MERGES_WITH',
            srcId,
            dstId,
          });
        }
      }
    },

    // UNION_MEMBER and INTERSECTS_WITH for type alias bodies
    TSUnionType(path: NodePath) {
      const node = path.node as t.TSUnionType;
      if (!node.types || node.types.length === 0) return;

      const unionLine = node.loc?.start.line ?? 0;
      const unionCol = node.loc?.start.column ?? 0;
      const unionStr = node.types.map(t => typeNodeToString(t)).join(' | ');
      const unionId = makeTypeNodeId(file, unionStr, unionLine, unionCol, ctx.typeNodeCounter++);

      miscNodes.push({
        id: unionId,
        type: 'TYPE',
        name: unionStr,
        file,
        line: unionLine,
        column: unionCol,
      });

      for (const memberType of node.types) {
        const memberStr = typeNodeToString(memberType);
        const memberLine = memberType.loc?.start.line ?? unionLine;
        const memberCol = memberType.loc?.start.column ?? unionCol;
        const memberId = makeTypeNodeId(file, memberStr, memberLine, memberCol, ctx.typeNodeCounter++);

        miscNodes.push({
          id: memberId,
          type: 'TYPE',
          name: memberStr,
          file,
          line: memberLine,
          column: memberCol,
        });

        miscEdges.push({
          edgeType: 'UNION_MEMBER',
          srcId: unionId,
          dstId: memberId,
        });
      }
    },

    TSIntersectionType(path: NodePath) {
      const node = path.node as t.TSIntersectionType;
      if (!node.types || node.types.length === 0) return;

      const intLine = node.loc?.start.line ?? 0;
      const intCol = node.loc?.start.column ?? 0;
      const intStr = node.types.map(t => typeNodeToString(t)).join(' & ');
      const intId = makeTypeNodeId(file, intStr, intLine, intCol, ctx.typeNodeCounter++);

      miscNodes.push({
        id: intId,
        type: 'TYPE',
        name: intStr,
        file,
        line: intLine,
        column: intCol,
      });

      for (const memberType of node.types) {
        const memberStr = typeNodeToString(memberType);
        const memberLine = memberType.loc?.start.line ?? intLine;
        const memberCol = memberType.loc?.start.column ?? intCol;
        const memberId = makeTypeNodeId(file, memberStr, memberLine, memberCol, ctx.typeNodeCounter++);

        miscNodes.push({
          id: memberId,
          type: 'TYPE',
          name: memberStr,
          file,
          line: memberLine,
          column: memberCol,
        });

        miscEdges.push({
          edgeType: 'INTERSECTS_WITH',
          srcId: intId,
          dstId: memberId,
        });
      }
    },

    TSInferType(path: NodePath) {
      const node = path.node as t.TSInferType;
      const param = node.typeParameter;
      if (!param) return;

      const paramName = param.name;
      const line = node.loc?.start.line ?? 0;
      const col = node.loc?.start.column ?? 0;

      const inferId = makeTypeNodeId(file, `infer ${paramName}`, line, col, ctx.typeNodeCounter++);

      miscNodes.push({
        id: inferId,
        type: 'TYPE_PARAMETER',
        name: paramName,
        file,
        line,
        column: col,
        metadata: { inferred: true }
      });

      // Find the parent conditional type and create both nodes + INFERS edge
      let parentPath = path.parentPath;
      while (parentPath) {
        if (parentPath.node.type === 'TSConditionalType') {
          const condLine = parentPath.node.loc?.start.line ?? 0;
          const condCol = parentPath.node.loc?.start.column ?? 0;
          const condId = `TYPE#conditional#${file}#${condLine}:${condCol}:${ctx.typeNodeCounter++}`;

          miscNodes.push({
            id: condId,
            type: 'TYPE',
            name: 'conditional',
            file,
            line: condLine,
            column: condCol,
          });

          miscEdges.push({
            edgeType: 'INFERS',
            srcId: condId,
            dstId: inferId,
          });
          break;
        }
        parentPath = parentPath.parentPath;
      }
    },

    // IMPLEMENTS_OVERLOAD + HAS_OVERLOAD: TypeScript overload signatures
    // TSDeclareFunction = overload signature, FunctionDeclaration with body = implementation
    TSDeclareFunction(path: NodePath) {
      const node = path.node as t.TSDeclareFunction;
      if (!node.id) return;

      const name = node.id.name;
      const line = node.loc?.start.line ?? 0;
      const col = node.loc?.start.column ?? 0;

      // Create overload signature node
      const overloadId = `misc:EXPRESSION:overload:${name}#${file}#${line}:${col}:${ctx.typeNodeCounter++}`;
      miscNodes.push({
        id: overloadId,
        type: 'FUNCTION',
        name: `${name}:overload`,
        file,
        line,
        column: col,
        metadata: { isOverloadSignature: true },
      });

      // Find the implementation (next sibling FunctionDeclaration with same name and body)
      const siblings = path.parent.type === 'Program'
        ? (path.parent as t.Program).body
        : [];
      for (const sibling of siblings) {
        if (
          sibling.type === 'FunctionDeclaration' &&
          sibling.id?.name === name &&
          sibling.body
        ) {
          const implLine = sibling.loc?.start.line ?? 0;
          const implCol = sibling.loc?.start.column ?? 0;
          const implId = `misc:EXPRESSION:impl:${name}#${file}#${implLine}:${implCol}:${ctx.typeNodeCounter++}`;
          miscNodes.push({
            id: implId,
            type: 'FUNCTION',
            name,
            file,
            line: implLine,
            column: implCol,
          });

          miscEdges.push({
            edgeType: 'IMPLEMENTS_OVERLOAD',
            srcId: implId,
            dstId: overloadId,
          });
          miscEdges.push({
            edgeType: 'HAS_OVERLOAD',
            srcId: implId,
            dstId: overloadId,
          });
          break;
        }
      }
    },

    // OVERRIDES: class method with override keyword
    ClassMethod(path: NodePath) {
      const node = path.node as t.ClassMethod;
      if (!(node as unknown as Record<string, unknown>).override) return;

      const methodName = node.key.type === 'Identifier' ? node.key.name : undefined;
      if (!methodName) return;

      const line = node.loc?.start.line ?? 0;
      const col = node.loc?.start.column ?? 0;

      // Find the parent class and its superClass
      const classPath = path.parentPath?.parentPath;
      if (!classPath || classPath.node.type !== 'ClassDeclaration') return;
      const classNode = classPath.node as t.ClassDeclaration;
      if (!classNode.superClass) return;

      const className = classNode.id?.name ?? 'Anonymous';
      const superName = classNode.superClass.type === 'Identifier'
        ? classNode.superClass.name : 'Unknown';

      // Create nodes for the overriding and overridden methods
      const overridingId = `misc:EXPRESSION:override:${className}.${methodName}#${file}#${line}:${col}:${ctx.typeNodeCounter++}`;
      const overriddenId = `misc:EXPRESSION:overridden:${superName}.${methodName}#${file}#${line}:${col}:${ctx.typeNodeCounter++}`;

      miscNodes.push({
        id: overridingId,
        type: 'FUNCTION',
        name: `${className}.${methodName}`,
        file,
        line,
        column: col,
      });
      miscNodes.push({
        id: overriddenId,
        type: 'FUNCTION',
        name: `${superName}.${methodName}`,
        file,
        line,
        column: col,
      });

      miscEdges.push({
        edgeType: 'OVERRIDES',
        srcId: overridingId,
        dstId: overriddenId,
      });
    },

    // EXTENDS_SCOPE_WITH: with-statement extends scope with object properties
    WithStatement(path: NodePath<t.WithStatement>) {
      const node = path.node;
      const obj = node.object;
      const line = node.loc?.start.line ?? 0;
      const col = node.loc?.start.column ?? 0;

      let objName = 'unknown';
      if (obj.type === 'Identifier') objName = obj.name;

      const scopeId = `misc:EXPRESSION:with-scope#${file}#${line}:${col}:${ctx.typeNodeCounter++}`;
      const objId = `misc:EXPRESSION:with-obj:${objName}#${file}#${line}:${col}:${ctx.typeNodeCounter++}`;

      miscNodes.push({
        id: scopeId,
        type: 'SCOPE',
        name: `with(${objName})`,
        file,
        line,
        column: col,
      });
      miscNodes.push({
        id: objId,
        type: 'EXPRESSION',
        name: objName,
        file,
        line,
        column: col,
      });

      miscEdges.push({
        edgeType: 'EXTENDS_SCOPE_WITH',
        srcId: scopeId,
        dstId: objId,
      });
    },
  };
}
