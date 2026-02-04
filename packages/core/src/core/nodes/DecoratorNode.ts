/**
 * DecoratorNode - contract for DECORATOR node
 *
 * Represents TypeScript/JavaScript decorators applied to
 * classes, methods, properties, or parameters.
 *
 * ID format: {file}:DECORATOR:{name}:{line}:{column}
 * Example: /src/services/UserService.ts:DECORATOR:Injectable:5:0
 */

import type { BaseNodeRecord } from '@grafema/types';

type DecoratorTargetType = 'CLASS' | 'METHOD' | 'PROPERTY' | 'PARAMETER';

interface DecoratorNodeRecord extends BaseNodeRecord {
  type: 'DECORATOR';
  column: number;
  arguments: unknown[];
  targetId: string;
  targetType: DecoratorTargetType;
}

interface DecoratorNodeOptions {
  arguments?: unknown[];
}

export class DecoratorNode {
  static readonly TYPE = 'DECORATOR' as const;

  static readonly REQUIRED = ['name', 'file', 'line', 'column', 'targetId', 'targetType'] as const;
  static readonly OPTIONAL = ['arguments'] as const;

  /**
   * Create DECORATOR node
   *
   * @param name - Decorator name
   * @param file - File path
   * @param line - Line number
   * @param column - Column position
   * @param targetId - ID of decorated element
   * @param targetType - Type of decorated element
   * @param options - Optional decorator properties
   * @returns DecoratorNodeRecord
   */
  static create(
    name: string,
    file: string,
    line: number,
    column: number,
    targetId: string,
    targetType: DecoratorTargetType,
    options: DecoratorNodeOptions = {}
  ): DecoratorNodeRecord {
    if (!name) throw new Error('DecoratorNode.create: name is required');
    if (!file) throw new Error('DecoratorNode.create: file is required');
    if (!line) throw new Error('DecoratorNode.create: line is required');
    if (column === undefined) throw new Error('DecoratorNode.create: column is required');
    if (!targetId) throw new Error('DecoratorNode.create: targetId is required');
    if (!targetType) throw new Error('DecoratorNode.create: targetType is required');

    return {
      id: `${file}:DECORATOR:${name}:${line}:${column}`,
      type: this.TYPE,
      name,
      file,
      line,
      column,
      arguments: options.arguments || [],
      targetId,
      targetType
    };
  }

  static validate(node: DecoratorNodeRecord): string[] {
    const errors: string[] = [];

    if (node.type !== this.TYPE) {
      errors.push(`Expected type ${this.TYPE}, got ${node.type}`);
    }

    const nodeRecord = node as unknown as Record<string, unknown>;
    for (const field of this.REQUIRED) {
      if (!nodeRecord[field]) {
        errors.push(`Missing required field: ${field}`);
      }
    }

    return errors;
  }
}

export type { DecoratorNodeRecord, DecoratorTargetType };
