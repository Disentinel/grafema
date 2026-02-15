/**
 * ReactFactory - factory methods for React domain graph nodes
 *
 * Handles: react:*, dom:*, browser:*, canvas:*
 */

import { ReactNode } from '../nodes/index.js';

import { brandNodeInternal } from '../brandNodeInternal.js';

export class ReactFactory {
  static createReactNode<T extends { id: string; type: string; file: string; line: number }>(fields: T) {
    return brandNodeInternal(ReactNode.create(fields));
  }
}
