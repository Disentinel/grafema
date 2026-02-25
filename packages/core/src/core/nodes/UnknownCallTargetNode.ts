/**
 * UnknownCallTargetNode - contract for UNKNOWN_CALL_TARGET node
 *
 * Represents a method call target that cannot be statically identified
 * as any known built-in, stdlib, or npm package. The object is a variable
 * whose type is unknown at analysis time.
 *
 * One node is created per distinct object name. All calls through the
 * same variable name point to the same node. Metadata carries both
 * object and method for coverage gap tracking.
 *
 * Examples:
 *   res.json(data)     -> UNKNOWN_CALL_TARGET:res
 *   socket.emit(event) -> UNKNOWN_CALL_TARGET:socket
 *   db.query(sql)      -> UNKNOWN_CALL_TARGET:db
 *
 * ID format: UNKNOWN_CALL_TARGET:{object}
 */

import type { BaseNodeRecord } from '@grafema/types';

interface UnknownCallTargetNodeRecord extends BaseNodeRecord {
  type: 'UNKNOWN_CALL_TARGET';
  object: string;
}

export class UnknownCallTargetNode {
  static readonly TYPE = 'UNKNOWN_CALL_TARGET' as const;

  static readonly REQUIRED = ['name', 'object'] as const;
  static readonly OPTIONAL = [] as const;

  /**
   * Create UNKNOWN_CALL_TARGET node
   *
   * @param objectName - Variable name of the unknown receiver (e.g., 'res', 'socket')
   * @returns UnknownCallTargetNodeRecord
   */
  static create(objectName: string): UnknownCallTargetNodeRecord {
    if (!objectName) throw new Error('UnknownCallTargetNode.create: objectName is required');

    return {
      id: `UNKNOWN_CALL_TARGET:${objectName}`,
      type: this.TYPE,
      name: objectName,
      object: objectName,
      file: '',
      line: 0
    };
  }

  static validate(node: UnknownCallTargetNodeRecord): string[] {
    const errors: string[] = [];
    if (node.type !== this.TYPE) {
      errors.push(`Expected type ${this.TYPE}, got ${node.type}`);
    }
    if (!node.name) {
      errors.push('Missing required field: name');
    }
    if (!node.object) {
      errors.push('Missing required field: object');
    }
    return errors;
  }
}

export type { UnknownCallTargetNodeRecord };
