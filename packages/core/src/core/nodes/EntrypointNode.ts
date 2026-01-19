/**
 * EntrypointNode - represents an executable entry point
 *
 * An ENTRYPOINT is any file that can be executed directly:
 * - service: main app entrypoint (package.json main/bin)
 * - cli: command-line tool
 * - test: test file
 * - script: dev/build script (package.json scripts)
 * - hook: git/tool hook (.husky/*, hooks/*.mjs)
 * - config: build config (*.config.js)
 */

import { createHash } from 'crypto';
import type { BaseNodeRecord } from '@grafema/types';

// Entrypoint types
export const ENTRYPOINT_TYPES = {
  SERVICE: 'service',     // Main app entrypoint
  CLI: 'cli',             // Command-line tool
  TEST: 'test',           // Test file
  SCRIPT: 'script',       // Dev/build script
  HOOK: 'hook',           // Git/tool hook
  CONFIG: 'config'        // Build config file
} as const;

export type EntrypointType = typeof ENTRYPOINT_TYPES[keyof typeof ENTRYPOINT_TYPES];

// What triggers execution
export const ENTRYPOINT_TRIGGERS = {
  RUNTIME: 'runtime',     // Production runtime
  BUILD: 'build',         // Build process
  DEV: 'dev',             // Development
  CI: 'ci',               // CI/CD pipeline
  MANUAL: 'manual'        // Manual execution
} as const;

export type EntrypointTrigger = typeof ENTRYPOINT_TRIGGERS[keyof typeof ENTRYPOINT_TRIGGERS];

// How entrypoint was discovered
export const ENTRYPOINT_SOURCES = {
  PACKAGE_MAIN: 'package.json:main',
  PACKAGE_BIN: 'package.json:bin',
  PACKAGE_SCRIPT: 'package.json:scripts',
  CONVENTION: 'convention',
  CONFIG: 'config',
  MANUAL: 'manual'
} as const;

export type EntrypointSource = typeof ENTRYPOINT_SOURCES[keyof typeof ENTRYPOINT_SOURCES];

interface EntrypointNodeRecord extends BaseNodeRecord {
  type: 'ENTRYPOINT';
  entrypointType: EntrypointType;
  trigger: EntrypointTrigger;
  source: string;
  serviceId: string | null;
}

interface EntrypointNodeOptions {
  id?: string;
  name?: string;
  trigger?: EntrypointTrigger;
  source?: string;
  serviceId?: string;
}

export class EntrypointNode {
  static readonly TYPE = 'ENTRYPOINT' as const;

  static readonly REQUIRED = ['file', 'entrypointType'] as const;
  static readonly OPTIONAL = ['trigger', 'source', 'serviceId', 'name'] as const;

  static readonly TYPES = ENTRYPOINT_TYPES;
  static readonly TRIGGERS = ENTRYPOINT_TRIGGERS;
  static readonly SOURCES = ENTRYPOINT_SOURCES;

  /**
   * Create ENTRYPOINT node
   */
  static create(
    file: string,
    entrypointType: EntrypointType,
    options: EntrypointNodeOptions = {}
  ): EntrypointNodeRecord {
    if (!file) throw new Error('EntrypointNode.create: file is required');
    if (!entrypointType) throw new Error('EntrypointNode.create: entrypointType is required');

    const id = options.id || this.generateId(file, entrypointType);

    return {
      id,
      type: this.TYPE,
      file,
      line: 0,
      name: options.name || this.extractName(file),
      entrypointType,
      trigger: options.trigger || this.inferTrigger(entrypointType),
      source: options.source || 'unknown',
      serviceId: options.serviceId || null
    };
  }

  /**
   * Generate stable ID for entrypoint
   */
  static generateId(file: string, type: string): string {
    const hash = createHash('md5').update(file).digest('hex').substring(0, 8);
    return `ENTRYPOINT:${type}:${hash}`;
  }

  /**
   * Extract name from file path
   */
  static extractName(file: string): string {
    const parts = file.split('/');
    return parts[parts.length - 1];
  }

  /**
   * Infer trigger from entrypoint type
   */
  static inferTrigger(entrypointType: EntrypointType): EntrypointTrigger {
    switch (entrypointType) {
      case this.TYPES.SERVICE:
      case this.TYPES.CLI:
        return this.TRIGGERS.RUNTIME;
      case this.TYPES.TEST:
        return this.TRIGGERS.CI;
      case this.TYPES.CONFIG:
        return this.TRIGGERS.BUILD;
      case this.TYPES.SCRIPT:
      case this.TYPES.HOOK:
        return this.TRIGGERS.DEV;
      default:
        return this.TRIGGERS.MANUAL;
    }
  }

  /**
   * Validate ENTRYPOINT node
   */
  static validate(node: EntrypointNodeRecord): string[] {
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

    if (node.entrypointType && !Object.values(this.TYPES).includes(node.entrypointType)) {
      errors.push(`Invalid entrypointType: ${node.entrypointType}`);
    }

    return errors;
  }
}

export type { EntrypointNodeRecord };
