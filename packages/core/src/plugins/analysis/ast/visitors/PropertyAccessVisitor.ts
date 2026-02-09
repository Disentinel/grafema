/**
 * PropertyAccessVisitor - handles property reads (MemberExpression) at module level
 *
 * Creates PROPERTY_ACCESS nodes for property reads like:
 * - Simple: config.maxBodyLength
 * - Chained: a.b.c → nodes for 'b' (objectName: "a") and 'c' (objectName: "a.b")
 * - Optional chaining: obj?.prop
 * - Computed: obj[key], obj['literal'], obj[0]
 *
 * Does NOT create nodes for:
 * - Method call targets: obj.method() → handled by CALL nodes
 * - Assignment LHS: obj.prop = value → handled by mutation tracking
 *
 * For chains ending in a call (a.b.c()):
 * - Intermediate links (a.b) get PROPERTY_ACCESS nodes
 * - The final link (c) is handled by CALL
 */

import type { MemberExpression, Identifier, StringLiteral, NumericLiteral, Node } from '@babel/types';
import type { NodePath } from '@babel/traverse';
import { ASTVisitor, type VisitorModule, type VisitorCollections, type VisitorHandlers } from './ASTVisitor.js';
import type { PropertyAccessInfo, CounterRef } from '../types.js';
import type { ScopeTracker } from '../../../../core/ScopeTracker.js';
import { computeSemanticId } from '../../../../core/SemanticId.js';
import { getLine, getColumn } from '../utils/location.js';

/**
 * Type alias for member-like expressions (both regular and optional chaining).
 * Babel uses separate AST types but they share the same structure.
 * Babel's MemberExpression has optional: boolean | null | undefined, so we use a wider type.
 */
type MemberLikeExpression = MemberExpression;

/**
 * Check if a node type is a member-like expression (regular or optional chaining).
 */
function isMemberLike(type: string): boolean {
  return type === 'MemberExpression' || type === 'OptionalMemberExpression';
}

/**
 * Check if a node type is a call-like expression (regular or optional chaining).
 */
function isCallLike(type: string): boolean {
  return type === 'CallExpression' || type === 'OptionalCallExpression' || type === 'NewExpression';
}

export class PropertyAccessVisitor extends ASTVisitor {
  private scopeTracker?: ScopeTracker;

  constructor(module: VisitorModule, collections: VisitorCollections, scopeTracker?: ScopeTracker) {
    super(module, collections);
    this.scopeTracker = scopeTracker;
  }

  getHandlers(): VisitorHandlers {
    const { module } = this;
    const propertyAccesses = (this.collections.propertyAccesses ?? []) as PropertyAccessInfo[];
    const propertyAccessCounterRef = (this.collections.propertyAccessCounterRef ?? { value: 0 }) as CounterRef;
    const scopeTracker = this.scopeTracker;

    const handler = (path: NodePath) => {
      const node = path.node as MemberLikeExpression;

      // Skip if inside function — analyzeFunctionBody handles those
      const functionParent = path.getFunctionParent();
      if (functionParent) {
        return;
      }

      PropertyAccessVisitor.extractPropertyAccesses(
        path,
        node,
        module,
        propertyAccesses,
        propertyAccessCounterRef,
        scopeTracker,
        module.id  // Module-level scope
      );
    };

    return {
      MemberExpression: handler,
      OptionalMemberExpression: handler
    };
  }

  /**
   * Process a MemberExpression (or OptionalMemberExpression) and extract PROPERTY_ACCESS nodes.
   *
   * This is the shared logic used by both module-level traversal (getHandlers)
   * and function-level traversal (called from JSASTAnalyzer.analyzeFunctionBody).
   */
  static extractPropertyAccesses(
    path: NodePath,
    node: MemberLikeExpression,
    module: VisitorModule,
    propertyAccesses: PropertyAccessInfo[],
    propertyAccessCounterRef: CounterRef,
    scopeTracker: ScopeTracker | undefined,
    parentScopeId: string
  ): void {
    // 1. Check if this MemberExpression is the callee of a CallExpression
    //    If so, skip the LEAF property (CALL handles it), but process intermediate links
    const isCallCallee = PropertyAccessVisitor.isDirectCallCallee(path);

    // 2. Check if this MemberExpression is the LHS of an assignment
    //    If so, skip entirely (mutation tracking handles writes)
    if (PropertyAccessVisitor.isAssignmentLHS(path)) {
      return;
    }

    // 3. Check if this MemberExpression is inside a parent MemberExpression
    //    If so, skip - we'll process it when we visit the outermost MemberExpression
    if (PropertyAccessVisitor.isChildOfMemberExpression(path)) {
      return;
    }

    // 4. Extract the chain and create PROPERTY_ACCESS info for each link
    const chain = PropertyAccessVisitor.extractChain(node, module, isCallCallee);

    for (const info of chain) {
      const fullName = `${info.objectName}.${info.propertyName}`;

      // Generate semantic ID
      let id: string;
      if (scopeTracker) {
        const discriminator = scopeTracker.getItemCounter(`PROPERTY_ACCESS:${fullName}`);
        id = computeSemanticId('PROPERTY_ACCESS', fullName, scopeTracker.getContext(), { discriminator });
      } else {
        id = `PROPERTY_ACCESS#${fullName}#${module.file}#${info.line}:${info.column}:${propertyAccessCounterRef.value++}`;
      }

      propertyAccesses.push({
        id,
        semanticId: id,
        type: 'PROPERTY_ACCESS',
        objectName: info.objectName,
        propertyName: info.propertyName,
        optional: info.optional,
        computed: info.computed,
        file: module.file,
        line: info.line,
        column: info.column,
        parentScopeId
      });
    }
  }

  /**
   * Check if this MemberExpression is the direct callee of a CallExpression.
   * e.g., in `obj.method()`, the MemberExpression `obj.method` is the callee.
   * Also handles OptionalCallExpression for `obj?.method()`.
   */
  private static isDirectCallCallee(path: NodePath): boolean {
    const parent = path.parent;
    if (!parent) return false;

    if (isCallLike(parent.type)) {
      return (parent as { callee: unknown }).callee === path.node;
    }

    return false;
  }

  /**
   * Check if this MemberExpression is the LHS of an AssignmentExpression.
   * e.g., in `obj.prop = value`, skip `obj.prop`.
   */
  private static isAssignmentLHS(path: NodePath): boolean {
    const parent = path.parent;
    if (!parent) return false;

    if (parent.type === 'AssignmentExpression') {
      return (parent as { left: unknown }).left === path.node;
    }

    // Also skip UpdateExpression targets: obj.prop++
    if (parent.type === 'UpdateExpression') {
      return true;
    }

    return false;
  }

  /**
   * Check if this MemberExpression is a child (object part) of another MemberExpression.
   * We only want to process the outermost MemberExpression in a chain to avoid duplicates.
   *
   * Handles both MemberExpression and OptionalMemberExpression.
   *
   * For `a.b.c`:
   * - The MemberExpression for `a.b` is the object of the outer MemberExpression for `a.b.c`
   * - We skip `a.b` when visited individually; process it when we visit `a.b.c`
   */
  private static isChildOfMemberExpression(path: NodePath): boolean {
    const parent = path.parent;
    if (!parent) return false;

    // If parent is any member-like expression and this node is the object (not the property), skip
    if (isMemberLike(parent.type)) {
      return (parent as MemberLikeExpression).object === path.node;
    }

    return false;
  }

  /**
   * Extract chain of property accesses from a MemberExpression (or OptionalMemberExpression).
   *
   * For `a.b.c`:
   * Babel AST: MemberExpression(object: MemberExpression(object: Identifier(a), property: b), property: c)
   * Result: [{objectName: "a", propertyName: "b"}, {objectName: "a.b", propertyName: "c"}]
   *
   * If isCallCallee is true, the leaf (outermost property) is skipped since CALL handles it.
   */
  private static extractChain(
    node: MemberLikeExpression,
    module: VisitorModule,
    isCallCallee: boolean
  ): Array<{
    objectName: string;
    propertyName: string;
    optional?: boolean;
    computed?: boolean;
    line: number;
    column: number;
  }> {
    // First, flatten the chain from outermost to innermost
    const segments: Array<{
      objectNode: MemberLikeExpression;
      propertyName: string;
      optional: boolean;
      computed: boolean;
      line: number;
      column: number;
    }> = [];

    let current: MemberLikeExpression | null = node;
    while (current) {
      const propName = PropertyAccessVisitor.getPropertyName(current);
      const propLine = current.property?.loc?.start?.line ?? getLine(current as Node);
      const propColumn = current.property?.loc?.start?.column ?? getColumn(current as Node);

      segments.unshift({
        objectNode: current,
        propertyName: propName,
        optional: current.optional === true,
        computed: current.computed === true,
        line: propLine,
        column: propColumn
      });

      // Walk into .object, which can be MemberExpression or OptionalMemberExpression
      if (isMemberLike(current.object.type)) {
        current = current.object as MemberLikeExpression;
      } else {
        current = null;
      }
    }

    // Build the result with proper objectName chain
    const result: Array<{
      objectName: string;
      propertyName: string;
      optional?: boolean;
      computed?: boolean;
      line: number;
      column: number;
    }> = [];

    // Get the base object name
    const baseObject = segments[0]?.objectNode.object;
    let baseName: string;
    if (baseObject?.type === 'Identifier') {
      baseName = (baseObject as Identifier).name;
    } else if (baseObject?.type === 'ThisExpression') {
      baseName = 'this';
    } else {
      // Complex expression as base - not trackable as simple property access
      return [];
    }

    let chainPrefix = baseName;
    const lastIndex = segments.length - 1;

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];

      // Skip the leaf if it's a call callee
      if (isCallCallee && i === lastIndex) {
        break;
      }

      result.push({
        objectName: chainPrefix,
        propertyName: seg.propertyName,
        optional: seg.optional || undefined,
        computed: seg.computed || undefined,
        line: seg.line,
        column: seg.column
      });

      // Build next prefix
      chainPrefix = `${chainPrefix}.${seg.propertyName}`;
    }

    return result;
  }

  /**
   * Extract property name from a MemberExpression (or OptionalMemberExpression).
   *
   * - obj.prop → "prop"
   * - obj['literal'] → "literal"
   * - obj[0] → "0"
   * - obj[variable] → "<computed>"
   */
  private static getPropertyName(node: MemberLikeExpression): string {
    const property = node.property;

    if (!node.computed) {
      // obj.prop
      if (property.type === 'Identifier') {
        return (property as Identifier).name;
      }
    } else {
      // obj['literal'] or obj["literal"]
      if (property.type === 'StringLiteral') {
        return (property as StringLiteral).value;
      }
      // obj[0]
      if (property.type === 'NumericLiteral') {
        return String((property as NumericLiteral).value);
      }
      // obj[variable] - computed, not statically resolvable
      return '<computed>';
    }

    return '<computed>';
  }
}
