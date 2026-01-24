/**
 * Branded Types - Type-safe node creation enforcement
 *
 * Branded types ensure that nodes can only be created through NodeFactory,
 * preventing inline object creation that bypasses validation.
 *
 * @example
 * // This compiles:
 * const node = NodeFactory.createFunction(...);
 * graph.addNode(node); // OK - node is BrandedNode
 *
 * // This fails to compile:
 * const inline = { type: 'FUNCTION', ... };
 * graph.addNode(inline); // ERROR - not a BrandedNode
 */

import type { BaseNodeRecord, NodeRecord } from './nodes.js';

/**
 * Unique symbol for branding nodes.
 * Declared but never actually exists at runtime - purely for type checking.
 */
declare const NODE_BRAND: unique symbol;

/**
 * A branded node type that can only be created through NodeFactory.
 *
 * The brand is a phantom type - it exists only in TypeScript's type system
 * and has no runtime representation. This makes it impossible to create
 * a BrandedNode without going through a function that returns one.
 *
 * @template T - The specific node record type (e.g., FunctionNodeRecord)
 */
export type BrandedNode<T extends BaseNodeRecord> = T & {
  readonly [NODE_BRAND]: true;
};

/**
 * Union type for any branded node.
 * Use this when you need to accept any valid node type.
 */
export type AnyBrandedNode = BrandedNode<NodeRecord>;

/**
 * Helper type to extract the underlying record type from a branded node.
 *
 * @example
 * type FnNode = BrandedNode<FunctionNodeRecord>;
 * type FnRecord = UnbrandedNode<FnNode>; // FunctionNodeRecord
 */
export type UnbrandedNode<T> = T extends BrandedNode<infer U> ? U : never;

/**
 * Type guard to check if a value is branded.
 * Note: This always returns true at runtime since branding is purely type-level.
 * It's useful for type narrowing in conditional logic.
 */
export function isBrandedNode<T extends BaseNodeRecord>(
  node: T | BrandedNode<T>
): node is BrandedNode<T> {
  // At runtime, all nodes from NodeFactory are considered branded.
  // The actual enforcement happens at compile time.
  return true;
}

/**
 * Internal helper for NodeFactory to brand a node.
 * This should ONLY be used inside NodeFactory methods.
 *
 * @internal
 */
export function brandNode<T extends BaseNodeRecord>(node: T): BrandedNode<T> {
  return node as BrandedNode<T>;
}
