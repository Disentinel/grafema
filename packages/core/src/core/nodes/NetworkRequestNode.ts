/**
 * NetworkRequestNode - contract for net:request singleton node
 *
 * Represents the external network as a system resource.
 * All HTTP_REQUEST nodes connect to this singleton via CALLS edges.
 *
 * This is NOT the same as HttpRequestNode (type: HTTP_REQUEST), which represents
 * individual HTTP request call sites in source code.
 *
 * Architectural role:
 * - net:request is a singleton representing external network (like net:stdio for console I/O)
 * - HTTP_REQUEST nodes are call sites that connect to this singleton via CALLS edges
 *
 * Example graph structure:
 * ```
 * /app/api.ts:HTTP_REQUEST:GET:15:0 --CALLS--> net:request#__network__
 * /app/service.ts:HTTP_REQUEST:POST:42:0 --CALLS--> net:request#__network__
 * ```
 */

import type { BaseNodeRecord } from '@grafema/types';

interface NetworkRequestNodeRecord extends BaseNodeRecord {
  type: 'net:request';
}

export class NetworkRequestNode {
  static readonly TYPE = 'net:request' as const;
  static readonly SINGLETON_ID = 'net:request#__network__';

  static readonly REQUIRED = ['name', 'file'] as const;
  static readonly OPTIONAL = [] as const;

  /**
   * Create net:request singleton node
   *
   * This node represents the external network as a system resource.
   * All HTTP_REQUEST nodes connect to this singleton via CALLS edges.
   *
   * Should be created once per graph. GraphBuilder and ExpressAnalyzer
   * use singleton deduplication to ensure only one instance exists.
   *
   * @returns NetworkRequestNodeRecord - singleton node
   */
  static create(): NetworkRequestNodeRecord {
    return {
      id: this.SINGLETON_ID,
      type: this.TYPE,
      name: '__network__',
      file: '__builtin__',
      line: 0
    };
  }

  /**
   * Validate net:request node structure
   *
   * Ensures:
   * - type is net:request (NOT NET_REQUEST)
   * - id matches SINGLETON_ID
   *
   * @param node - Node to validate
   * @returns Array of error messages (empty if valid)
   */
  static validate(node: NetworkRequestNodeRecord): string[] {
    const errors: string[] = [];
    if (node.type !== this.TYPE) {
      errors.push(`Expected type ${this.TYPE}, got ${node.type}`);
    }
    if (node.id !== this.SINGLETON_ID) {
      errors.push(`Invalid singleton ID: expected ${this.SINGLETON_ID}, got ${node.id}`);
    }
    return errors;
  }
}

export type { NetworkRequestNodeRecord };
