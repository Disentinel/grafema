/**
 * GuaranteeNode - contract for contract-based guarantee nodes
 *
 * Types: guarantee:queue, guarantee:api, guarantee:permission
 * ID format: guarantee:queue#orders, guarantee:api#rate-limit
 *
 * Unlike Datalog-based GUARANTEE nodes (handled by GuaranteeManager),
 * these nodes use JSON schema validation for contract verification.
 */

import type { BaseNodeRecord } from '@grafema/types';
import { NAMESPACED_TYPE, isGuaranteeType } from './NodeKind.js';

// Re-export types from nodes.ts for convenience
export type GuaranteePriority = 'critical' | 'important' | 'observed' | 'tracked';
export type GuaranteeStatus = 'discovered' | 'reviewed' | 'active' | 'changing' | 'deprecated';
export type GuaranteeType = 'guarantee:queue' | 'guarantee:api' | 'guarantee:permission';

export interface GuaranteeNodeRecord extends BaseNodeRecord {
  type: GuaranteeType;
  priority: GuaranteePriority;
  status: GuaranteeStatus;
  owner?: string;
  schema?: Record<string, unknown>;
  condition?: string;
  description?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface GuaranteeNodeOptions {
  priority?: GuaranteePriority;
  status?: GuaranteeStatus;
  owner?: string;
  schema?: Record<string, unknown>;
  condition?: string;
  description?: string;
}

// Valid guarantee namespaces
const GUARANTEE_NAMESPACES = ['queue', 'api', 'permission'] as const;
type GuaranteeNamespace = typeof GUARANTEE_NAMESPACES[number];

export class GuaranteeNode {
  static readonly TYPE_QUEUE = NAMESPACED_TYPE.GUARANTEE_QUEUE;
  static readonly TYPE_API = NAMESPACED_TYPE.GUARANTEE_API;
  static readonly TYPE_PERMISSION = NAMESPACED_TYPE.GUARANTEE_PERMISSION;

  static readonly REQUIRED = ['name', 'file', 'priority', 'status'] as const;
  static readonly OPTIONAL = ['owner', 'schema', 'condition', 'description', 'createdAt', 'updatedAt'] as const;

  /**
   * Create guarantee node
   * @param namespace - guarantee namespace (queue, api, permission)
   * @param name - guarantee name (e.g., 'orders', 'rate-limit')
   * @param options - optional fields
   */
  static create(
    namespace: GuaranteeNamespace,
    name: string,
    options: GuaranteeNodeOptions = {}
  ): GuaranteeNodeRecord {
    if (!namespace) throw new Error('GuaranteeNode.create: namespace is required');
    if (!name) throw new Error('GuaranteeNode.create: name is required');
    if (!GUARANTEE_NAMESPACES.includes(namespace)) {
      throw new Error(`GuaranteeNode.create: invalid namespace "${namespace}". Valid: ${GUARANTEE_NAMESPACES.join(', ')}`);
    }

    const type = `guarantee:${namespace}` as GuaranteeType;
    const id = `${type}#${name}`;
    const now = Date.now();

    return {
      id,
      type,
      name,
      file: '', // Guarantees don't have a source file
      line: undefined,
      priority: options.priority || 'observed',
      status: options.status || 'discovered',
      owner: options.owner,
      schema: options.schema,
      condition: options.condition,
      description: options.description,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Validate guarantee node
   * @returns array of error messages, empty if valid
   */
  static validate(node: GuaranteeNodeRecord): string[] {
    const errors: string[] = [];

    if (!isGuaranteeType(node.type)) {
      errors.push(`Expected guarantee:* type, got ${node.type}`);
    }

    if (!node.name) {
      errors.push('Missing required field: name');
    }

    if (!node.priority) {
      errors.push('Missing required field: priority');
    } else if (!['critical', 'important', 'observed', 'tracked'].includes(node.priority)) {
      errors.push(`Invalid priority: ${node.priority}. Valid: critical, important, observed, tracked`);
    }

    if (!node.status) {
      errors.push('Missing required field: status');
    } else if (!['discovered', 'reviewed', 'active', 'changing', 'deprecated'].includes(node.status)) {
      errors.push(`Invalid status: ${node.status}. Valid: discovered, reviewed, active, changing, deprecated`);
    }

    return errors;
  }

  /**
   * Parse guarantee ID into components
   * @param id - full ID (e.g., 'guarantee:queue#orders')
   * @returns { namespace, name } or null if invalid
   */
  static parseId(id: string): { namespace: GuaranteeNamespace; name: string } | null {
    if (!id) return null;

    // Format: guarantee:namespace#name
    const match = id.match(/^guarantee:(queue|api|permission)#(.+)$/);
    if (!match) return null;

    return {
      namespace: match[1] as GuaranteeNamespace,
      name: match[2],
    };
  }

  /**
   * Build ID from components
   */
  static buildId(namespace: GuaranteeNamespace, name: string): string {
    return `guarantee:${namespace}#${name}`;
  }

  /**
   * Check if node type is a guarantee type
   */
  static isGuaranteeType(type: string): boolean {
    return isGuaranteeType(type);
  }

  /**
   * Get all valid guarantee types
   */
  static getTypes(): GuaranteeType[] {
    return [
      NAMESPACED_TYPE.GUARANTEE_QUEUE,
      NAMESPACED_TYPE.GUARANTEE_API,
      NAMESPACED_TYPE.GUARANTEE_PERMISSION,
    ];
  }
}
