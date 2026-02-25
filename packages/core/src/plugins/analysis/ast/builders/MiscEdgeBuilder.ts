/**
 * MiscEdgeBuilder - buffers misc edges and nodes from MiscEdgeCollector,
 * plus creates additional edges from existing collection data.
 *
 * Self-contained edges (from MiscEdgeCollector, both src and dst are created by collector):
 * - UNION_MEMBER, INTERSECTS_WITH, INFERS, SPREADS_FROM, DELETES,
 *   ACCESSES_PRIVATE, SHADOWS, MERGES_WITH
 *
 * Collection-derived edges (built from existing collections here):
 * - DEFAULTS_TO, RETURNS_TYPE, HAS_TYPE, CONSTRAINED_BY,
 *   CHAINS_FROM, AWAITS, CALLS_ON, ALIASES, LISTENS_TO,
 *   BINDS_THIS_TO, INVOKES, IMPLEMENTS_OVERLOAD, HAS_OVERLOAD,
 *   OVERRIDES, EXTENDS_SCOPE_WITH
 */

import type {
  ModuleNode,
  ASTCollections,
  FunctionInfo,
} from '../types.js';
import type { BuilderContext, DomainBuilder } from './types.js';

export class MiscEdgeBuilder implements DomainBuilder {
  constructor(private ctx: BuilderContext) {}

  buffer(module: ModuleNode, data: ASTCollections): void {
    const { miscEdges = [], miscNodes = [] } = data;

    // Buffer misc nodes first (e.g., TYPE nodes for annotations)
    for (const node of miscNodes) {
      this.ctx.bufferNode({
        id: node.id,
        type: node.type,
        name: node.name,
        file: node.file,
        line: node.line,
        column: node.column,
        ...node.metadata
      });
    }

    // Buffer self-contained misc edges (UNION_MEMBER, INTERSECTS_WITH, INFERS)
    for (const edge of miscEdges) {
      this.ctx.bufferEdge({
        type: edge.edgeType,
        src: edge.srcId,
        dst: edge.dstId,
        ...edge.metadata
      });
    }

    // Create collection-derived edges
    this.bufferDefaultsToEdges(data);
    this.bufferReturnsTypeEdges(data);
    this.bufferHasTypeEdges(data);
    this.bufferConstrainedByEdges(data);
    this.bufferChainsFromEdges(data);
    this.bufferAwaitsEdges(data);
    this.bufferCallsOnEdges(data);
    this.bufferAliasesEdges(data);
    this.bufferListensToEdges(data);
    this.bufferBindsThisToEdges(data);
    this.bufferInvokesEdges(data);
    this.bufferOverloadEdges(data);
    this.bufferOverridesEdges(data);
    this.bufferExtendsScopeWithEdges(data);
  }

  /**
   * DEFAULTS_TO: PARAMETER → default value node.
   * Uses ParameterInfo.hasDefault to find parameters with defaults.
   * Creates a LITERAL/EXPRESSION node for the default value.
   */
  private bufferDefaultsToEdges(data: ASTCollections): void {
    const { parameters = [] } = data;
    let counter = 0;
    for (const param of parameters) {
      if (!param.hasDefault) continue;
      const paramId = param.semanticId ?? param.id;
      // Create a synthetic default value node
      const defaultId = `misc:EXPRESSION:default:${param.name}#${param.file}#${param.line}:${param.column ?? 0}:${counter++}`;
      this.ctx.bufferNode({
        id: defaultId,
        type: 'EXPRESSION',
        name: `default(${param.name})`,
        file: param.file,
        line: param.line,
        column: param.column,
      });
      this.ctx.bufferEdge({
        type: 'DEFAULTS_TO',
        src: paramId,
        dst: defaultId,
      });
    }
  }

  /**
   * RETURNS_TYPE: FUNCTION → TYPE node for return type annotation.
   * Uses FunctionInfo metadata for return type string.
   */
  private bufferReturnsTypeEdges(data: ASTCollections): void {
    const { functions } = data;
    let counter = 0;
    for (const func of functions) {
      const returnType = (func as unknown as Record<string, unknown>).returnType as string | undefined;
      if (!returnType || returnType === 'unknown') continue;

      const typeId = `TYPE#ret:${returnType}#${func.file}#${func.line}:${func.column ?? 0}:${counter++}`;
      this.ctx.bufferNode({
        id: typeId,
        type: 'TYPE',
        name: returnType,
        file: func.file,
        line: func.line,
        column: func.column,
      });
      this.ctx.bufferEdge({
        type: 'RETURNS_TYPE',
        src: func.id,
        dst: typeId,
      });
    }
  }

  /**
   * HAS_TYPE: VARIABLE/CONSTANT → TYPE node for type annotation.
   * Uses VariableDeclarationInfo metadata for type annotation string.
   */
  private bufferHasTypeEdges(data: ASTCollections): void {
    const { variableDeclarations } = data;
    let counter = 0;
    for (const varDecl of variableDeclarations) {
      const tsType = (varDecl as unknown as Record<string, unknown>).tsType as string | undefined;
      if (!tsType || tsType === 'unknown') continue;

      const typeId = `TYPE#var:${tsType}#${varDecl.file}#${varDecl.line}:${varDecl.column ?? 0}:${counter++}`;
      this.ctx.bufferNode({
        id: typeId,
        type: 'TYPE',
        name: tsType,
        file: varDecl.file,
        line: varDecl.line,
        column: varDecl.column,
      });
      this.ctx.bufferEdge({
        type: 'HAS_TYPE',
        src: varDecl.id,
        dst: typeId,
      });
    }
  }

  /**
   * CONSTRAINED_BY: TYPE_PARAMETER → TYPE (the constraint).
   * Uses TypeParameterInfo.constraintType.
   */
  private bufferConstrainedByEdges(data: ASTCollections): void {
    const { typeParameters = [] } = data;
    let counter = 0;
    for (const tp of typeParameters) {
      if (!tp.constraintType) continue;

      // Create the constraint TYPE node
      const constraintId = `TYPE#constraint:${tp.constraintType}#${tp.file}#${tp.line}:${tp.column ?? 0}:${counter++}`;
      this.ctx.bufferNode({
        id: constraintId,
        type: 'TYPE',
        name: tp.constraintType,
        file: tp.file,
        line: tp.line,
        column: tp.column,
      });

      // Create the CONSTRAINED_BY edge
      // TypeParameter node ID format: parentId:TYPE_PARAMETER:name
      const tpNodeId = `${tp.parentId}:TYPE_PARAMETER:${tp.name}`;
      this.ctx.bufferEdge({
        type: 'CONSTRAINED_BY',
        src: tpNodeId,
        dst: constraintId,
      });
    }
  }

  /**
   * CHAINS_FROM: CALL → CALL for method chains like a().b().c().
   * Detects chains by matching methodCalls where object is at the same position as another call.
   */
  private bufferChainsFromEdges(data: ASTCollections): void {
    const { callSites = [], methodCalls = [] } = data;

    // Build a position → callId index for all calls
    const callByPosition = new Map<string, string>();
    for (const call of callSites) {
      if (call.line && call.column !== undefined) {
        callByPosition.set(`${call.file}:${call.line}:${call.column}`, call.id);
      }
    }
    for (const call of methodCalls) {
      if (call.line && call.column !== undefined) {
        callByPosition.set(`${call.file}:${call.line}:${call.column}`, call.id);
      }
    }

    // Check method calls where the object position matches another call
    for (const mc of methodCalls) {
      const objectLine = (mc as unknown as Record<string, unknown>).objectLine as number | undefined;
      const objectColumn = (mc as unknown as Record<string, unknown>).objectColumn as number | undefined;
      if (objectLine === undefined || objectColumn === undefined) continue;

      const innerCallId = callByPosition.get(`${mc.file}:${objectLine}:${objectColumn}`);
      if (innerCallId && mc.id !== innerCallId) {
        this.ctx.bufferEdge({
          type: 'CHAINS_FROM',
          src: mc.id,
          dst: innerCallId,
        });
      }
    }
  }

  /**
   * AWAITS: Detects await expressions from callSites/methodCalls that have isAwaited flag.
   */
  private bufferAwaitsEdges(data: ASTCollections): void {
    const { callSites = [], methodCalls = [] } = data;

    for (const call of callSites) {
      const isAwaited = (call as unknown as Record<string, unknown>).isAwaited as boolean | undefined;
      if (!isAwaited) continue;

      // Create EXPRESSION node for the await wrapper
      const awaitId = `misc:EXPRESSION:await#${call.file}#${call.line}:${call.column ?? 0}`;
      this.ctx.bufferNode({
        id: awaitId,
        type: 'EXPRESSION',
        name: 'await',
        file: call.file,
        line: call.line,
        column: call.column,
      });
      this.ctx.bufferEdge({
        type: 'AWAITS',
        src: awaitId,
        dst: call.id,
      });
    }

    for (const call of methodCalls) {
      const isAwaited = (call as unknown as Record<string, unknown>).isAwaited as boolean | undefined;
      if (!isAwaited) continue;

      const awaitId = `misc:EXPRESSION:await#${call.file}#${call.line}:${call.column ?? 0}`;
      this.ctx.bufferNode({
        id: awaitId,
        type: 'EXPRESSION',
        name: 'await',
        file: call.file,
        line: call.line,
        column: call.column,
      });
      this.ctx.bufferEdge({
        type: 'AWAITS',
        src: awaitId,
        dst: call.id,
      });
    }
  }

  /**
   * CALLS_ON: CALL → VARIABLE/PARAMETER for the receiver object.
   * From methodCalls where object is a named identifier (not 'this' or '<chain>').
   */
  private bufferCallsOnEdges(data: ASTCollections): void {
    const { methodCalls = [], variableDeclarations, parameters = [] } = data;

    // Build variable/parameter lookup by name
    const varByName = new Map<string, string>();
    for (const v of variableDeclarations) {
      varByName.set(v.name, v.id);
    }
    for (const p of parameters) {
      const pid = p.semanticId ?? p.id;
      varByName.set(p.name, pid);
    }

    for (const mc of methodCalls) {
      if (!mc.object || mc.object === 'this' || mc.object === '<chain>') continue;
      const targetId = varByName.get(mc.object);
      if (targetId) {
        this.ctx.bufferEdge({
          type: 'CALLS_ON',
          src: mc.id,
          dst: targetId,
        });
      }
    }
  }

  /**
   * ALIASES: VARIABLE → VARIABLE when one variable is assigned the value of another.
   * From variableAssignments where sourceType is 'VARIABLE'.
   */
  private bufferAliasesEdges(data: ASTCollections): void {
    const { variableAssignments = [], variableDeclarations, parameters = [] } = data;

    // Build name → id lookup
    const varByName = new Map<string, string>();
    for (const v of variableDeclarations) {
      varByName.set(v.name, v.id);
    }
    for (const p of parameters) {
      varByName.set(p.name, p.semanticId ?? p.id);
    }

    for (const va of variableAssignments) {
      if (va.sourceType !== 'VARIABLE') continue;
      const sourceName = va.sourceName;
      if (!sourceName) continue;
      const targetId = va.sourceId ?? varByName.get(sourceName);
      if (!targetId) continue;
      this.ctx.bufferEdge({
        type: 'ALIASES',
        src: va.variableId,
        dst: targetId,
      });
    }
  }

  /**
   * LISTENS_TO: EVENT_LISTENER → event name EXPRESSION node.
   * From eventListeners collection.
   */
  private bufferListensToEdges(data: ASTCollections): void {
    const { eventListeners = [] } = data;
    let counter = 0;
    for (const el of eventListeners) {
      const eventId = `misc:EXPRESSION:event:${el.name}#${el.file}#${el.line}:${counter++}`;
      this.ctx.bufferNode({
        id: eventId,
        type: 'EXPRESSION',
        name: el.name,
        file: el.file,
        line: el.line,
      });
      this.ctx.bufferEdge({
        type: 'LISTENS_TO',
        src: el.id,
        dst: eventId,
      });
    }
  }

  /**
   * BINDS_THIS_TO: CALL → target when .bind()/.call()/.apply() is used.
   * From methodCalls where method is 'bind', 'call', or 'apply'.
   */
  private bufferBindsThisToEdges(data: ASTCollections): void {
    const { methodCalls = [] } = data;
    for (const mc of methodCalls) {
      if (mc.method !== 'bind' && mc.method !== 'call' && mc.method !== 'apply') continue;
      // The object is the function being bound
      const objectId = `misc:EXPRESSION:${mc.object}#${mc.file}#${mc.line}`;
      this.ctx.bufferNode({
        id: objectId,
        type: 'EXPRESSION',
        name: mc.object,
        file: mc.file,
        line: mc.line,
      });
      this.ctx.bufferEdge({
        type: 'BINDS_THIS_TO',
        src: mc.id,
        dst: objectId,
      });
    }
  }

  /**
   * INVOKES: dynamic invocations — .call(), .apply(), Function() calls.
   * From methodCalls where method is 'call' or 'apply'.
   */
  private bufferInvokesEdges(data: ASTCollections): void {
    const { methodCalls = [] } = data;
    for (const mc of methodCalls) {
      if (mc.method !== 'call' && mc.method !== 'apply') continue;
      const targetId = `misc:EXPRESSION:invoked:${mc.object}#${mc.file}#${mc.line}`;
      this.ctx.bufferNode({
        id: targetId,
        type: 'EXPRESSION',
        name: `${mc.object}(invoked)`,
        file: mc.file,
        line: mc.line,
      });
      this.ctx.bufferEdge({
        type: 'INVOKES',
        src: mc.id,
        dst: targetId,
      });
    }
  }

  /**
   * IMPLEMENTS_OVERLOAD + HAS_OVERLOAD: TypeScript function overloads.
   * Functions with isOverload flag implement overload signatures.
   */
  private bufferOverloadEdges(data: ASTCollections): void {
    const { functions } = data;

    // Group functions by name+file to find overloads
    const byNameFile = new Map<string, FunctionInfo[]>();
    for (const func of functions) {
      const key = `${func.name}#${func.file}`;
      if (!byNameFile.has(key)) byNameFile.set(key, []);
      byNameFile.get(key)!.push(func);
    }

    for (const [, group] of byNameFile) {
      if (group.length < 2) continue;

      // TypeScript overloads: multiple declarations with same name,
      // the last one is the implementation, others are overload signatures
      const isOverload = (func: FunctionInfo) =>
        (func as unknown as Record<string, unknown>).isOverload === true;

      const overloads = group.filter(isOverload);
      const impl = group.find(f => !isOverload(f));
      if (overloads.length === 0 || !impl) continue;

      for (const overload of overloads) {
        // IMPLEMENTS_OVERLOAD: implementation → overload signature
        this.ctx.bufferEdge({
          type: 'IMPLEMENTS_OVERLOAD',
          src: impl.id,
          dst: overload.id,
        });
        // HAS_OVERLOAD: parent (implementation) has this overload
        this.ctx.bufferEdge({
          type: 'HAS_OVERLOAD',
          src: impl.id,
          dst: overload.id,
        });
      }
    }
  }

  /**
   * OVERRIDES: CLASS_METHOD → parent CLASS_METHOD when overriding.
   * Uses classDeclarations + DERIVES_FROM to find parent methods.
   */
  private bufferOverridesEdges(data: ASTCollections): void {
    const { functions, classDeclarations = [] } = data;

    // Build class → methods map
    const classMethods = new Map<string, Map<string, string>>();
    for (const func of functions) {
      const parentScope = (func as unknown as Record<string, unknown>).parentScopeId as string | undefined;
      if (!parentScope) continue;
      // Check if parent is a class
      for (const cls of classDeclarations) {
        if (parentScope === cls.id || parentScope.endsWith(`:${cls.name}`)) {
          if (!classMethods.has(cls.id)) classMethods.set(cls.id, new Map());
          classMethods.get(cls.id)!.set(func.name, func.id);
          break;
        }
      }
    }

    // Check for method name matches between child and parent classes
    for (const cls of classDeclarations) {
      const parentName = (cls as unknown as Record<string, unknown>).superClass as string | undefined;
      if (!parentName) continue;

      const childMethods = classMethods.get(cls.id);
      if (!childMethods) continue;

      // Find parent class
      const parentCls = classDeclarations.find(c => c.name === parentName);
      if (!parentCls) continue;

      const parentMethods = classMethods.get(parentCls.id);
      if (!parentMethods) continue;

      for (const [methodName, childMethodId] of childMethods) {
        const parentMethodId = parentMethods.get(methodName);
        if (parentMethodId && parentMethodId !== childMethodId) {
          this.ctx.bufferEdge({
            type: 'OVERRIDES',
            src: childMethodId,
            dst: parentMethodId,
          });
        }
      }
    }
  }

  /**
   * EXTENDS_SCOPE_WITH: closure or with-statement scope extension.
   * Functions that capture variables from outer scope extend that scope.
   */
  private bufferExtendsScopeWithEdges(data: ASTCollections): void {
    const { functions } = data;
    for (const func of functions) {
      const captures = (func as unknown as Record<string, unknown>).captures as string[] | undefined;
      if (!captures || captures.length === 0) continue;
      // Create edge from the function's scope to the outer scope it captures from
      const scopeId = `SCOPE#${func.name}#${func.file}#${func.line}`;
      this.ctx.bufferNode({
        id: scopeId,
        type: 'SCOPE',
        name: `closure(${func.name})`,
        file: func.file,
        line: func.line,
      });
      this.ctx.bufferEdge({
        type: 'EXTENDS_SCOPE_WITH',
        src: func.id,
        dst: scopeId,
      });
    }
  }
}
