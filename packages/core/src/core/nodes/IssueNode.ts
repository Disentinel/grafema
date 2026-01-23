/**
 * IssueNode - contract for issue:* nodes
 *
 * Types: issue:security, issue:performance, issue:style, issue:smell
 * ID format: issue:<category>#<hash>
 *
 * Issues represent detected problems in the codebase.
 * They connect to affected code via AFFECTS edges.
 */

import { createHash } from 'crypto';
import type { BaseNodeRecord } from '@grafema/types';
import { getNamespace } from './NodeKind.js';

// Severity type
export type IssueSeverity = 'error' | 'warning' | 'info';

// Issue types
export type IssueType = `issue:${string}`;

export interface IssueNodeRecord extends BaseNodeRecord {
  type: IssueType;
  severity: IssueSeverity;
  category: string;
  message: string;
  plugin: string;
  targetNodeId?: string;
  createdAt: number;
  context?: Record<string, unknown>;
}

export interface IssueNodeOptions {
  context?: Record<string, unknown>;
}

// Valid severity levels
const VALID_SEVERITIES = ['error', 'warning', 'info'] as const;

export class IssueNode {
  static readonly REQUIRED = ['category', 'severity', 'message', 'plugin', 'file'] as const;
  static readonly OPTIONAL = ['targetNodeId', 'context'] as const;

  /**
   * Generate deterministic issue ID
   * Format: issue:<category>#<hash12>
   *
   * Hash is based on plugin + file + line + column + message
   * This ensures same issue = same ID across analysis runs
   */
  static generateId(
    category: string,
    plugin: string,
    file: string,
    line: number,
    column: number,
    message: string
  ): string {
    const hashInput = `${plugin}|${file}|${line}|${column}|${message}`;
    const hash = createHash('sha256').update(hashInput).digest('hex').substring(0, 12);
    return `issue:${category}#${hash}`;
  }

  /**
   * Create issue node
   *
   * @param category - Issue category (security, performance, style, smell, or custom)
   * @param severity - error | warning | info
   * @param message - Human-readable description
   * @param plugin - Plugin name that detected this issue
   * @param file - File where issue was detected
   * @param line - Line number
   * @param column - Column number (optional, defaults to 0)
   * @param options - Optional fields (context)
   */
  static create(
    category: string,
    severity: IssueSeverity,
    message: string,
    plugin: string,
    file: string,
    line: number,
    column: number = 0,
    options: IssueNodeOptions = {}
  ): IssueNodeRecord {
    if (!category) throw new Error('IssueNode.create: category is required');
    if (!severity) throw new Error('IssueNode.create: severity is required');
    if (!VALID_SEVERITIES.includes(severity)) {
      throw new Error(`IssueNode.create: invalid severity "${severity}". Valid: ${VALID_SEVERITIES.join(', ')}`);
    }
    if (!message) throw new Error('IssueNode.create: message is required');
    if (!plugin) throw new Error('IssueNode.create: plugin is required');
    if (!file) throw new Error('IssueNode.create: file is required');

    const type = `issue:${category}` as IssueType;
    const id = this.generateId(category, plugin, file, line, column, message);
    const now = Date.now();

    return {
      id,
      type,
      name: message.substring(0, 100), // Truncate for display
      file,
      line,
      column,
      severity,
      category,
      message,
      plugin,
      createdAt: now,
      context: options.context,
    };
  }

  /**
   * Validate issue node
   * @returns array of error messages, empty if valid
   */
  static validate(node: IssueNodeRecord): string[] {
    const errors: string[] = [];

    if (!IssueNode.isIssueType(node.type)) {
      errors.push(`Expected issue:* type, got ${node.type}`);
    }

    if (!node.category) {
      errors.push('Missing required field: category');
    }

    if (!node.severity) {
      errors.push('Missing required field: severity');
    } else if (!VALID_SEVERITIES.includes(node.severity as IssueSeverity)) {
      errors.push(`Invalid severity: ${node.severity}. Valid: ${VALID_SEVERITIES.join(', ')}`);
    }

    if (!node.message) {
      errors.push('Missing required field: message');
    }

    if (!node.plugin) {
      errors.push('Missing required field: plugin');
    }

    return errors;
  }

  /**
   * Parse issue ID into components
   * @param id - full ID (e.g., 'issue:security#a3f2b1c4d5e6')
   * @returns { category, hash } or null if invalid
   */
  static parseId(id: string): { category: string; hash: string } | null {
    if (!id) return null;

    const match = id.match(/^issue:([^#]+)#(.+)$/);
    if (!match) return null;

    return {
      category: match[1],
      hash: match[2],
    };
  }

  /**
   * Check if type is an issue type
   */
  static isIssueType(type: string): boolean {
    if (!type) return false;
    return getNamespace(type) === 'issue';
  }

  /**
   * Get all known issue categories
   */
  static getCategories(): string[] {
    return ['security', 'performance', 'style', 'smell'];
  }
}
