/**
 * Node display formatting utilities - REG-125
 *
 * Provides consistent formatting for node display across all CLI commands.
 * Semantic IDs are shown as the PRIMARY identifier, with location as secondary.
 */

import { relative } from 'path';

/**
 * Format options for node display
 */
export interface FormatNodeOptions {
  /** Project path for relative file paths */
  projectPath: string;
  /** Include location line (default: true) */
  showLocation?: boolean;
  /** Prefix for each line (default: '') */
  indent?: string;
}

/**
 * Node information required for display
 */
export interface DisplayableNode {
  /** Semantic ID (e.g., "auth/service.ts->AuthService->FUNCTION->authenticate") */
  id: string;
  /** Node type (e.g., "FUNCTION", "CLASS") */
  type: string;
  /** Human-readable name */
  name: string;
  /** Absolute file path */
  file: string;
  /** Line number (optional) */
  line?: number;
}

/**
 * Format a node for primary display (multi-line)
 *
 * Output format:
 *   [FUNCTION] authenticate
 *     ID: auth/service.ts->AuthService->FUNCTION->authenticate
 *     Location: auth/service.ts:42
 */
export function formatNodeDisplay(node: DisplayableNode, options: FormatNodeOptions): string {
  const { projectPath, showLocation = true, indent = '' } = options;
  const lines: string[] = [];

  // Line 1: [TYPE] name
  lines.push(`${indent}[${node.type}] ${node.name}`);

  // Line 2: ID (semantic ID)
  lines.push(`${indent}  ID: ${node.id}`);

  // Line 3: Location (optional)
  if (showLocation) {
    const loc = formatLocation(node.file, node.line, projectPath);
    if (loc) {
      lines.push(`${indent}  Location: ${loc}`);
    }
  }

  return lines.join('\n');
}

/**
 * Format a node for inline display in lists (semantic ID only)
 *
 * Output format:
 *   auth/service.ts->AuthService->FUNCTION->authenticate
 */
export function formatNodeInline(node: DisplayableNode): string {
  return node.id;
}

/**
 * Format file location relative to project
 */
export function formatLocation(
  file: string | undefined,
  line: number | undefined,
  projectPath: string
): string {
  if (!file) return '';
  const relPath = relative(projectPath, file);
  return line ? `${relPath}:${line}` : relPath;
}
