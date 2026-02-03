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
  /** HTTP method (for http:route, http:request) */
  method?: string;
  /** Path or URL (for http:route, http:request) */
  path?: string;
  /** URL (for http:request) */
  url?: string;
}

/**
 * Get the display name for a node based on its type.
 *
 * HTTP nodes use method + path/url instead of name.
 * Other nodes use their name field.
 */
export function getNodeDisplayName(node: DisplayableNode): string {
  switch (node.type) {
    case 'http:route':
      // Express routes: "GET /users"
      if (node.method && node.path) {
        return `${node.method} ${node.path}`;
      }
      break;
    case 'http:request':
      // Fetch/axios requests: "POST /api/data"
      if (node.method && node.url) {
        return `${node.method} ${node.url}`;
      }
      break;
  }
  // Default: use name, but guard against JSON metadata corruption
  if (node.name && !node.name.startsWith('{')) {
    return node.name;
  }
  // Fallback: extract name from semantic ID if possible
  const parts = node.id.split('#');
  if (parts.length > 1) {
    return parts[1]; // Usually contains the key identifier
  }
  return node.id;
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

  // Line 1: [TYPE] display name (type-specific)
  const displayName = getNodeDisplayName(node);
  lines.push(`${indent}[${node.type}] ${displayName}`);

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
