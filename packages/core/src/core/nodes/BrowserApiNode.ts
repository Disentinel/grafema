/**
 * BrowserApiNode - contract for BROWSER_API node
 *
 * Represents a browser-only Web Platform API. Not available in Node.js
 * without polyfills. Defined by W3C/WHATWG browser specifications.
 *
 * Examples: document, window, navigator, localStorage, sessionStorage,
 *           location, history, requestAnimationFrame
 *
 * ID format: BROWSER_API:{name}
 * Examples:
 *   BROWSER_API:document
 *   BROWSER_API:window
 *   BROWSER_API:localStorage
 */

import type { BaseNodeRecord } from '@grafema/types';

interface BrowserApiNodeRecord extends BaseNodeRecord {
  type: 'BROWSER_API';
}

export class BrowserApiNode {
  static readonly TYPE = 'BROWSER_API' as const;

  static readonly REQUIRED = ['name'] as const;
  static readonly OPTIONAL = [] as const;

  /**
   * Create BROWSER_API node
   *
   * @param name - API name (e.g., 'document', 'window', 'localStorage')
   * @returns BrowserApiNodeRecord
   */
  static create(name: string): BrowserApiNodeRecord {
    if (!name) throw new Error('BrowserApiNode.create: name is required');

    return {
      id: `BROWSER_API:${name}`,
      type: this.TYPE,
      name,
      file: '',
      line: 0
    };
  }

  static validate(node: BrowserApiNodeRecord): string[] {
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

export type { BrowserApiNodeRecord };
