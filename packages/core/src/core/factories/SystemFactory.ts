/**
 * SystemFactory - factory methods for system infrastructure node types
 *
 * Handles: SYSTEM_DB_VIEW_REGISTRATION, SYSTEM_DB_SUBSCRIPTION
 */

import { brandNodeInternal } from '../brandNodeInternal.js';
import type { BaseNodeRecord, BrandedNode } from '@grafema/types';

interface SystemDbViewRegistrationOptions {
  viewName: string;
  serverName: string;
  callType: string;
  file: string;
  line: number;
  column: number;
}

interface SystemDbSubscriptionOptions {
  servers: string[];
  file: string;
  line: number;
  column: number;
}

const SYSTEM_DB_TYPES = ['SYSTEM_DB_VIEW_REGISTRATION', 'SYSTEM_DB_SUBSCRIPTION'] as const;

export class SystemFactory {
  static createSystemDbViewRegistration(
    nodeId: string,
    params: SystemDbViewRegistrationOptions,
  ): BrandedNode<BaseNodeRecord> {
    if (!nodeId) throw new Error('SystemFactory.createSystemDbViewRegistration: nodeId is required');

    return brandNodeInternal({
      id: nodeId,
      type: 'SYSTEM_DB_VIEW_REGISTRATION',
      name: `${params.callType}('${params.viewName}', '${params.serverName}')`,
      file: params.file,
      line: params.line,
      column: params.column,
      viewName: params.viewName,
      serverName: params.serverName,
      callType: params.callType,
    } as BaseNodeRecord);
  }

  static createSystemDbSubscription(
    nodeId: string,
    params: SystemDbSubscriptionOptions,
  ): BrandedNode<BaseNodeRecord> {
    if (!nodeId) throw new Error('SystemFactory.createSystemDbSubscription: nodeId is required');

    return brandNodeInternal({
      id: nodeId,
      type: 'SYSTEM_DB_SUBSCRIPTION',
      name: `subscribe([${params.servers.join(', ')}])`,
      file: params.file,
      line: params.line,
      column: params.column,
      servers: params.servers,
    } as BaseNodeRecord);
  }

  /**
   * Check if a type belongs to the system_db domain.
   */
  static isSystemDbType(type: string): boolean {
    return SYSTEM_DB_TYPES.includes(type as typeof SYSTEM_DB_TYPES[number]);
  }

  /**
   * Validate a system_db domain node.
   */
  static validate(node: BaseNodeRecord): string[] {
    const errors: string[] = [];

    if (!SystemFactory.isSystemDbType(node.type)) {
      errors.push(`Expected SYSTEM_DB_* type, got ${node.type}`);
    }

    if (!node.name) {
      errors.push('Missing required field: name');
    }

    if (!node.file) {
      errors.push('Missing required field: file');
    }

    return errors;
  }
}
