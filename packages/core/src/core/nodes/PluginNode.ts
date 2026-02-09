/**
 * PluginNode - contract for grafema:plugin nodes
 *
 * Type: grafema:plugin
 * ID format: grafema:plugin#HTTPConnectionEnricher
 *
 * Represents a Grafema plugin registered in the analysis pipeline.
 * Created by the Orchestrator at startup, before the first analysis phase.
 * Enables agents to query plugin metadata without reading source code.
 */

import type { BaseNodeRecord } from '@grafema/types';
import { NAMESPACED_TYPE } from './NodeKind.js';

export interface PluginNodeRecord extends BaseNodeRecord {
  type: 'grafema:plugin';
  phase: string;
  priority: number;
  builtin: boolean;
  createsNodes: string[];
  createsEdges: string[];
  dependencies: string[];
}

export interface PluginNodeOptions {
  priority?: number;
  file?: string;
  line?: number;
  builtin?: boolean;
  createsNodes?: string[];
  createsEdges?: string[];
  dependencies?: string[];
}

const VALID_PHASES = ['DISCOVERY', 'INDEXING', 'ANALYSIS', 'ENRICHMENT', 'VALIDATION'] as const;

export class PluginNode {
  static readonly TYPE = NAMESPACED_TYPE.GRAFEMA_PLUGIN;
  static readonly REQUIRED = ['name', 'phase'] as const;
  static readonly OPTIONAL = ['priority', 'file', 'builtin', 'createsNodes', 'createsEdges', 'dependencies'] as const;

  /**
   * Generate plugin node ID.
   * Format: grafema:plugin#<name>
   */
  static generateId(name: string): string {
    return `grafema:plugin#${name}`;
  }

  /**
   * Create plugin node from metadata.
   *
   * @param name - Plugin class name (e.g., 'HTTPConnectionEnricher')
   * @param phase - Plugin phase (e.g., 'ENRICHMENT')
   * @param options - Optional fields
   */
  static create(
    name: string,
    phase: string,
    options: PluginNodeOptions = {}
  ): PluginNodeRecord {
    if (!name) throw new Error('PluginNode.create: name is required');
    if (!phase) throw new Error('PluginNode.create: phase is required');

    if (!(VALID_PHASES as readonly string[]).includes(phase)) {
      throw new Error(`PluginNode.create: invalid phase "${phase}". Valid: ${VALID_PHASES.join(', ')}`);
    }

    const id = this.generateId(name);

    return {
      id,
      type: 'grafema:plugin',
      name,
      phase,
      priority: options.priority ?? 0,
      file: options.file ?? '',
      line: options.line,
      builtin: options.builtin ?? true,
      createsNodes: options.createsNodes ?? [],
      createsEdges: options.createsEdges ?? [],
      dependencies: options.dependencies ?? [],
      metadata: {
        creates: {
          nodes: options.createsNodes ?? [],
          edges: options.createsEdges ?? [],
        },
        dependencies: options.dependencies ?? [],
        builtin: options.builtin ?? true,
      },
    };
  }

  /**
   * Validate plugin node.
   * @returns array of error messages, empty if valid
   */
  static validate(node: BaseNodeRecord): string[] {
    const errors: string[] = [];
    const record = node as PluginNodeRecord;

    if (node.type !== 'grafema:plugin') {
      errors.push(`Expected grafema:plugin type, got ${node.type}`);
    }

    if (!record.name) {
      errors.push('Missing required field: name');
    }

    if (!record.phase) {
      errors.push('Missing required field: phase');
    }

    return errors;
  }

  /**
   * Parse plugin ID into components.
   * @param id - full ID (e.g., 'grafema:plugin#HTTPConnectionEnricher')
   * @returns { name } or null if invalid
   */
  static parseId(id: string): { name: string } | null {
    if (!id) return null;

    const match = id.match(/^grafema:plugin#(.+)$/);
    if (!match) return null;

    return { name: match[1] };
  }

  /**
   * Build plugin node ID from name.
   */
  static buildId(name: string): string {
    return `grafema:plugin#${name}`;
  }

  /**
   * Check if type is a grafema:plugin type.
   */
  static isPluginType(type: string): boolean {
    return type === 'grafema:plugin';
  }
}
