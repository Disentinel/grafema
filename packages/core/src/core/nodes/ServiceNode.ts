/**
 * ServiceNode - contract for SERVICE node
 */

import type { BaseNodeRecord } from '@grafema/types';

interface ServiceNodeRecord extends BaseNodeRecord {
  type: 'SERVICE';
  kind: 'SERVICE';
  filePath: string;
  version: string;
  entrypoint: string;
  discoveryMethod: string;
  description?: string;
  dependencies: string[];
  serviceType?: string;
  testFiles?: string[];
}

interface ServiceNodeOptions {
  version?: string;
  entrypoint?: string;
  discoveryMethod?: string;
  description?: string;
  dependencies?: string[];
  serviceType?: string;
  testFiles?: string[];
  metadata?: {
    type?: string;
    testFiles?: string[];
  };
}

export class ServiceNode {
  static readonly TYPE = 'SERVICE' as const;

  static readonly REQUIRED = ['name', 'file'] as const;
  static readonly OPTIONAL = ['version', 'entrypoint', 'discoveryMethod', 'description', 'dependencies', 'metadata', 'testFiles', 'serviceType'] as const;

  /**
   * Create SERVICE node
   */
  static create(name: string, projectPath: string, options: ServiceNodeOptions = {}): ServiceNodeRecord {
    if (!name) throw new Error('ServiceNode.create: name is required');
    if (!projectPath) throw new Error('ServiceNode.create: projectPath is required');

    return {
      id: `SERVICE:${name}`,
      type: this.TYPE,
      kind: this.TYPE,
      name,
      file: projectPath,
      line: 0,
      filePath: projectPath,
      version: options.version || '0.0.0',
      entrypoint: options.entrypoint || 'index.js',
      discoveryMethod: options.discoveryMethod || 'unknown',
      description: options.description,
      dependencies: options.dependencies || [],
      serviceType: options.metadata?.type || options.serviceType,
      testFiles: options.metadata?.testFiles || options.testFiles
    };
  }

  /**
   * Validate SERVICE node
   */
  static validate(node: ServiceNodeRecord): string[] {
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

export type { ServiceNodeRecord };
