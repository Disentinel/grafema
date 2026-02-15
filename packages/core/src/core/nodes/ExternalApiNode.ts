/**
 * ExternalApiNode - contract for EXTERNAL nodes
 *
 * Represents an external API domain detected from HTTP requests.
 * Created by FetchAnalyzer when URLs point to external hosts.
 *
 * ID format: EXTERNAL#${domain}
 */

import type { BaseNodeRecord } from '@grafema/types';

interface ExternalApiNodeRecord extends BaseNodeRecord {
  type: 'EXTERNAL';
}

export class ExternalApiNode {
  static readonly TYPE = 'EXTERNAL' as const;

  static readonly REQUIRED = ['name'] as const;
  static readonly OPTIONAL = ['domain'] as const;

  /**
   * Create EXTERNAL node for an API domain
   *
   * @param domain - External API domain (e.g., "api.github.com")
   */
  static create(domain: string): ExternalApiNodeRecord {
    const id = `EXTERNAL#${domain}`;

    return {
      id,
      type: this.TYPE,
      name: domain,
      domain,
    } as ExternalApiNodeRecord;
  }

  /**
   * Validate EXTERNAL node structure
   */
  static validate(node: ExternalApiNodeRecord): string[] {
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

export type { ExternalApiNodeRecord };
