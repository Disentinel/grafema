/**
 * WebApiNode - contract for WEB_API node
 *
 * Represents a WHATWG/W3C web platform API that is available in BOTH
 * browsers AND modern Node.js (18+). Not ECMAScript spec, not Node.js-only.
 *
 * Examples: console, fetch, URL, setTimeout, setInterval, queueMicrotask,
 *           performance, AbortController, TextEncoder, FormData
 *
 * ID format: WEB_API:{name}
 * Examples:
 *   WEB_API:console
 *   WEB_API:setTimeout
 *   WEB_API:fetch
 */

import type { BaseNodeRecord } from '@grafema/types';

interface WebApiNodeRecord extends BaseNodeRecord {
  type: 'WEB_API';
}

export class WebApiNode {
  static readonly TYPE = 'WEB_API' as const;

  static readonly REQUIRED = ['name'] as const;
  static readonly OPTIONAL = [] as const;

  /**
   * Create WEB_API node
   *
   * @param name - API name (e.g., 'console', 'setTimeout', 'fetch')
   * @returns WebApiNodeRecord
   */
  static create(name: string): WebApiNodeRecord {
    if (!name) throw new Error('WebApiNode.create: name is required');

    return {
      id: `WEB_API:${name}`,
      type: this.TYPE,
      name,
      file: '',
      line: 0
    };
  }

  static validate(node: WebApiNodeRecord): string[] {
    const errors: string[] = [];
    if (node.type !== this.TYPE) {
      errors.push(`Expected type ${this.TYPE}, got ${node.type}`);
    }
    if (!node.name) {
      errors.push('Missing required field: name');
    }
    return errors;
  }
}

export type { WebApiNodeRecord };
