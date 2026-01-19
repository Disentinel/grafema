/**
 * EventListenerNode - contract for EVENT_LISTENER node
 */

import type { BaseNodeRecord } from '@grafema/types';

interface EventListenerNodeRecord extends BaseNodeRecord {
  type: 'EVENT_LISTENER';
  object?: string;
  parentScopeId?: string;
  callbackArg?: string;
}

interface EventListenerNodeOptions {
  column?: number;
  parentScopeId?: string;
  callbackArg?: string;
  counter?: number;
}

export class EventListenerNode {
  static readonly TYPE = 'EVENT_LISTENER' as const;

  static readonly REQUIRED = ['name', 'file', 'line'] as const;
  static readonly OPTIONAL = ['object', 'column', 'parentScopeId', 'callbackArg'] as const;

  static create(
    eventName: string,
    objectName: string | undefined,
    file: string,
    line: number,
    options: EventListenerNodeOptions = {}
  ): EventListenerNodeRecord {
    if (!eventName) throw new Error('EventListenerNode.create: eventName is required');
    if (!file) throw new Error('EventListenerNode.create: file is required');
    if (line === undefined) throw new Error('EventListenerNode.create: line is required');

    const counter = options.counter !== undefined ? `:${options.counter}` : '';
    const id = `${file}:EVENT_LISTENER:${eventName}:${line}:${options.column || 0}${counter}`;

    return {
      id,
      type: this.TYPE,
      name: eventName,
      object: objectName,
      file,
      line,
      parentScopeId: options.parentScopeId,
      callbackArg: options.callbackArg
    };
  }

  static validate(node: EventListenerNodeRecord): string[] {
    const errors: string[] = [];
    if (node.type !== this.TYPE) errors.push(`Expected type ${this.TYPE}`);
    const nodeRecord = node as unknown as Record<string, unknown>;
    for (const field of this.REQUIRED) {
      if (nodeRecord[field] === undefined) errors.push(`Missing: ${field}`);
    }
    return errors;
  }
}

export type { EventListenerNodeRecord };
