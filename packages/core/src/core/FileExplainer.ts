/**
 * FileExplainer - Show what nodes exist in a file for discovery
 *
 * Purpose: Help users discover what nodes exist in the graph for a file,
 * displaying semantic IDs so users can query them.
 *
 * This addresses the core UX problem: users can't find nodes because
 * semantic IDs are opaque (e.g., "src/app.ts->fetchData->try#0->VARIABLE->response").
 * This tool shows what's in the graph so users know what they can query.
 *
 * @see _tasks/REG-177/006-don-revised-plan.md for design rationale
 */

import type { GraphBackend, BaseNodeRecord, NodeFilter } from '@grafema/types';

/**
 * Result of explaining a file's graph contents
 */
export interface FileExplainResult {
  /** The file path that was explained */
  file: string;
  /** Whether the file has been analyzed */
  status: 'ANALYZED' | 'NOT_ANALYZED';
  /** All nodes in the graph for this file, enhanced with context */
  nodes: EnhancedNode[];
  /** Node counts grouped by type */
  byType: Record<string, number>;
  /** Total number of nodes in the file */
  totalCount: number;
}

/**
 * A node record enhanced with scope context information.
 *
 * The context field provides human-readable information about
 * where the node appears (e.g., "inside try block", "catch parameter").
 */
export interface EnhancedNode extends BaseNodeRecord {
  /** Human-readable context about the node's scope */
  context?: string;
}

/**
 * Scope patterns to detect from semantic IDs.
 * Order matters - more specific patterns should come first.
 */
const SCOPE_PATTERNS: Array<{ pattern: RegExp; context: string }> = [
  { pattern: /->catch#\d+->/, context: 'inside catch block' },
  { pattern: /->try#\d+->/, context: 'inside try block' },
  { pattern: /->if#\d+->/, context: 'inside conditional' },
  { pattern: /->else#\d+->/, context: 'inside else block' },
  { pattern: /->for#\d+->/, context: 'inside loop' },
  { pattern: /->while#\d+->/, context: 'inside loop' },
  { pattern: /->switch#\d+->/, context: 'inside switch' },
];

/**
 * FileExplainer class - explains what nodes exist in a file's graph.
 *
 * Use this when:
 * - User can't find a variable/function they expect to be in the graph
 * - User wants to understand what's been analyzed for a file
 * - User needs semantic IDs to construct queries
 *
 * Example:
 * ```typescript
 * const explainer = new FileExplainer(graphBackend);
 * const result = await explainer.explain('src/app.ts');
 *
 * if (result.status === 'NOT_ANALYZED') {
 *   console.log('File not in graph. Run: grafema analyze');
 * } else {
 *   for (const node of result.nodes) {
 *     console.log(`[${node.type}] ${node.name}`);
 *     console.log(`  ID: ${node.id}`);
 *     if (node.context) {
 *       console.log(`  Context: ${node.context}`);
 *     }
 *   }
 * }
 * ```
 */
export class FileExplainer {
  constructor(private graph: GraphBackend) {}

  /**
   * Explain what nodes exist in the graph for a file.
   *
   * @param filePath - The file path to explain (relative or absolute)
   * @returns FileExplainResult with all nodes, grouped by type, with context
   */
  async explain(filePath: string): Promise<FileExplainResult> {
    // Query graph for all nodes in this file
    const nodes = await this.getNodesForFile(filePath);

    // Group by type
    const byType = this.groupByType(nodes);

    // Enhance with context from semantic ID parsing
    const enhanced = this.enhanceWithContext(nodes);

    // Sort nodes: by type, then by name
    enhanced.sort((a, b) => {
      const typeCompare = a.type.localeCompare(b.type);
      if (typeCompare !== 0) return typeCompare;
      return (a.name || '').localeCompare(b.name || '');
    });

    return {
      file: filePath,
      status: nodes.length > 0 ? 'ANALYZED' : 'NOT_ANALYZED',
      nodes: enhanced,
      byType,
      totalCount: nodes.length,
    };
  }

  /**
   * Query graph for all nodes in a file
   *
   * Note: The server-side file filter may not work correctly in all cases,
   * so we also filter client-side to ensure only nodes from the requested file are returned.
   */
  private async getNodesForFile(filePath: string): Promise<BaseNodeRecord[]> {
    const filter: NodeFilter = { file: filePath };
    const nodes: BaseNodeRecord[] = [];

    for await (const node of this.graph.queryNodes(filter)) {
      // Client-side filter as backup (server filter may not work correctly)
      if (node.file === filePath) {
        nodes.push(node);
      }
    }

    return nodes;
  }

  /**
   * Group nodes by type, counting occurrences
   */
  private groupByType(nodes: BaseNodeRecord[]): Record<string, number> {
    const counts: Record<string, number> = {};

    for (const node of nodes) {
      const type = node.type || 'UNKNOWN';
      counts[type] = (counts[type] || 0) + 1;
    }

    return counts;
  }

  /**
   * Enhance nodes with human-readable scope context.
   *
   * Detects patterns in semantic IDs like:
   * - "file->func->try#0->VARIABLE->x" → "inside try block"
   * - "file->func->catch#0->VARIABLE->error" → "inside catch block"
   */
  private enhanceWithContext(nodes: BaseNodeRecord[]): EnhancedNode[] {
    return nodes.map((node) => {
      const context = this.detectScopeContext(node.id);
      return context ? { ...node, context } : { ...node };
    });
  }

  /**
   * Detect scope context from semantic ID patterns.
   *
   * Returns human-readable context string or undefined if no special scope.
   */
  private detectScopeContext(semanticId: string): string | undefined {
    for (const { pattern, context } of SCOPE_PATTERNS) {
      if (pattern.test(semanticId)) {
        return context;
      }
    }
    return undefined;
  }
}
