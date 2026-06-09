/**
 * Node display formatting utilities - REG-125
 *
 * Provides consistent formatting for node display across all CLI commands.
 * Semantic IDs are shown as the PRIMARY identifier, with location as secondary.
 */

import { isAbsolute, relative } from 'path';
import { parseSemanticIdV2 } from '@grafema/util';

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
  /** Source file path (relative to project root, or absolute for legacy) */
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
  // Fallback: derive a human-readable name from the semantic ID.
  // Semantic IDs (v2 compact `file->TYPE->name[in:p,h:x]#N` and grafema://
  // URIs) carry the symbol name. parseSemanticIdV2 decodes URIs and strips
  // the bracket payload / discriminator, returning the bare name. The old
  // `id.split('#')[1]` returned the discriminator number (e.g. "2") or the
  // percent-encoded TYPE chain for these formats — never the name.
  const parsed = parseSemanticIdV2(node.id);
  if (parsed?.name) {
    return parsed.name;
  }
  // Synthetic IDs that are not arrow-chain semantic IDs (e.g. the legacy
  // `http:route#GET:/path#file#line` form) keep their key segment after the
  // scheme prefix.
  const parts = node.id.split('#');
  if (parts.length > 1) {
    return parts[1];
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
  const relPath = isAbsolute(file) ? relative(projectPath, file) : file;
  return line ? `${relPath}:${line}` : relPath;
}
