/**
 * MCP Knowledge Handlers
 */

import { getOrCreateKnowledgeBase } from '../state.js';
import { textResult, errorResult } from '../utils.js';
import type {
  ToolResult,
  AddKnowledgeArgs,
  QueryKnowledgeArgs,
  QueryDecisionsArgs,
  SupersedeFactArgs,
  GitChurnArgs,
  GitCoChangeArgs,
  GitOwnershipArgs,
  GitArchaeologyArgs,
} from '../types.js';
import type { KBDecision, KBNodeType } from '@grafema/util';
import { getChurn, getCoChanges, getOwnership, getArchaeology } from '@grafema/util';

/**
 * Add a new knowledge node.
 */
export async function handleAddKnowledge(args: AddKnowledgeArgs): Promise<ToolResult> {
  try {
    const kb = await getOrCreateKnowledgeBase();

    const node = await kb.addNode({
      type: args.type as KBNodeType,
      content: args.content,
      slug: args.slug,
      subtype: args.subtype,
      scope: args.scope as 'global' | 'project' | 'module' | undefined,
      projections: args.projections,
      relates_to: args.relates_to,
      status: args.status as KBDecision['status'],
      confidence: args.confidence as 'high' | 'medium' | 'low',
      effective_from: args.effective_from,
      applies_to: args.applies_to,
      task_id: args.task_id,
    });

    return textResult(
      `Created ${node.type} node: ${node.id}\n` +
      `File: ${node.filePath}\n` +
      `Lifecycle: ${node.lifecycle}\n` +
      (node.content.length > 200
        ? `Content: ${node.content.slice(0, 200)}...`
        : `Content: ${node.content}`)
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResult(`Failed to add knowledge: ${message}`);
  }
}

/**
 * Query knowledge nodes with filters.
 */
export async function handleQueryKnowledge(args: QueryKnowledgeArgs): Promise<ToolResult> {
  try {
    const kb = await getOrCreateKnowledgeBase();

    const nodes = await kb.queryNodes({
      type: args.type as KBNodeType | undefined,
      projection: args.projection,
      relates_to: args.relates_to,
      text: args.text,
      include_dangling_only: args.include_dangling_only,
    });

    if (nodes.length === 0) {
      return textResult('No matching knowledge nodes found.');
    }

    const lines: string[] = [`Found ${nodes.length} node(s):\n`];
    for (const node of nodes) {
      lines.push(`## ${node.id}`);
      lines.push(`Type: ${node.type} | Lifecycle: ${node.lifecycle}`);
      if (node.projections.length > 0) lines.push(`Projections: ${node.projections.join(', ')}`);
      if (node.type === 'DECISION') {
        const d = node as KBDecision;
        lines.push(`Status: ${d.status}`);
        if (d.applies_to?.length) lines.push(`Applies to: ${d.applies_to.join(', ')}`);
      }

      // Include resolution status for code references
      const resolved = await kb.resolveReferences(node);
      if (resolved.length > 0) {
        lines.push('Code refs:');
        for (const r of resolved) {
          const icon = r.status === 'resolved' ? 'OK' : 'DANGLING';
          lines.push(`  [${icon}] ${r.address}${r.codeNodeId ? ` → ${r.codeNodeId}` : ''}`);
        }
      }

      lines.push('');
      lines.push(node.content.length > 500 ? node.content.slice(0, 500) + '...' : node.content);
      lines.push('');
    }

    return textResult(lines.join('\n'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResult(`Failed to query knowledge: ${message}`);
  }
}

/**
 * Query decisions, optionally filtered by module or status.
 */
export async function handleQueryDecisions(args: QueryDecisionsArgs): Promise<ToolResult> {
  try {
    const kb = await getOrCreateKnowledgeBase();

    let decisions: KBDecision[];

    if (args.module) {
      decisions = await kb.activeDecisionsFor(args.module);
      if (args.status) {
        decisions = decisions.filter(d => d.status === args.status);
      }
    } else {
      const nodes = await kb.queryNodes({
        type: 'DECISION',
        status: args.status,
      });
      decisions = nodes as KBDecision[];
    }

    if (decisions.length === 0) {
      return textResult('No matching decisions found.');
    }

    const lines: string[] = [`Found ${decisions.length} decision(s):\n`];
    for (const d of decisions) {
      lines.push(`## ${d.id} [${d.status}]`);
      if (d.applies_to?.length) lines.push(`Applies to: ${d.applies_to.join(', ')}`);
      if (d.effective_from) lines.push(`Effective from: ${d.effective_from}`);
      if (d.superseded_by) lines.push(`Superseded by: ${d.superseded_by}`);
      lines.push('');
      lines.push(d.content);
      lines.push('');
    }

    return textResult(lines.join('\n'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResult(`Failed to query decisions: ${message}`);
  }
}

/**
 * Supersede an existing fact with a new version.
 */
export async function handleSupersedeFact(args: SupersedeFactArgs): Promise<ToolResult> {
  try {
    const kb = await getOrCreateKnowledgeBase();

    const result = await kb.supersedeFact(args.old_id, args.new_content, args.new_slug);

    return textResult(
      `Superseded fact:\n` +
      `Old: ${result.old.id} (now has superseded_by: ${result.old.superseded_by})\n` +
      `New: ${result.new.id}\n` +
      `File: ${result.new.filePath}`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResult(`Failed to supersede fact: ${message}`);
  }
}

/**
 * Get knowledge base statistics.
 */
export async function handleGetKnowledgeStats(): Promise<ToolResult> {
  try {
    const kb = await getOrCreateKnowledgeBase();
    const stats = await kb.getStats();

    const lines: string[] = [
      `## Knowledge Base Stats\n`,
      `Total nodes: ${stats.totalNodes}`,
      `Total edges: ${stats.totalEdges}`,
    ];

    if (Object.keys(stats.byType).length > 0) {
      lines.push('\n### By Type');
      for (const [type, count] of Object.entries(stats.byType)) {
        lines.push(`- ${type}: ${count}`);
      }
    }

    if (Object.keys(stats.byLifecycle).length > 0) {
      lines.push('\n### By Lifecycle');
      for (const [lifecycle, count] of Object.entries(stats.byLifecycle)) {
        lines.push(`- ${lifecycle}: ${count}`);
      }
    }

    if (Object.keys(stats.edgesByType).length > 0) {
      lines.push('\n### Edges by Type');
      for (const [type, count] of Object.entries(stats.edgesByType)) {
        lines.push(`- ${type}: ${count}`);
      }
    }

    if (stats.danglingRefs.length > 0) {
      lines.push(`\n### Dangling KB References (${stats.danglingRefs.length})`);
      for (const ref of stats.danglingRefs.slice(0, 10)) {
        lines.push(`- ${ref}`);
      }
      if (stats.danglingRefs.length > 10) {
        lines.push(`... and ${stats.danglingRefs.length - 10} more`);
      }
    }

    if (stats.danglingCodeRefs.length > 0) {
      lines.push(`\n### Dangling Code References (${stats.danglingCodeRefs.length})`);
      for (const ref of stats.danglingCodeRefs.slice(0, 10)) {
        lines.push(`- ${ref.nodeId} → ${ref.address}`);
      }
      if (stats.danglingCodeRefs.length > 10) {
        lines.push(`... and ${stats.danglingCodeRefs.length - 10} more`);
      }
    }

    return textResult(lines.join('\n'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResult(`Failed to get knowledge stats: ${message}`);
  }
}

/**
 * Get churn analysis — files ranked by change frequency.
 */
export async function handleGitChurn(args: GitChurnArgs): Promise<ToolResult> {
  try {
    const kb = await getOrCreateKnowledgeBase();
    const entries = await getChurn(kb, { limit: args.limit, since: args.since });

    if (entries.length === 0) {
      return textResult('No churn data found. Run `grafema git-ingest` first to ingest git history.');
    }

    const lines: string[] = [`## File Churn (${entries.length} files)\n`];
    for (const entry of entries) {
      lines.push(`${entry.changeCount} changes | +${entry.totalAdded} -${entry.totalRemoved} | ${entry.path}`);
    }

    return textResult(lines.join('\n'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResult(`Failed to get churn data: ${message}`);
  }
}

/**
 * Get co-change analysis — files that change together.
 */
export async function handleGitCoChange(args: GitCoChangeArgs): Promise<ToolResult> {
  try {
    const kb = await getOrCreateKnowledgeBase();
    const entries = await getCoChanges(kb, args.file, { minSupport: args.min_support });

    if (entries.length === 0) {
      return textResult(`No co-change data found for "${args.file}". The file may not appear in git history, or run \`grafema git-ingest\` first.`);
    }

    const lines: string[] = [`## Co-changes with ${args.file} (${entries.length} files)\n`];
    for (const entry of entries) {
      const pct = (entry.support * 100).toFixed(0);
      lines.push(`${entry.coChangeCount} co-changes (${pct}%) | ${entry.path}`);
    }

    return textResult(lines.join('\n'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResult(`Failed to get co-change data: ${message}`);
  }
}

/**
 * Get ownership analysis — authors ranked by contribution.
 */
export async function handleGitOwnership(args: GitOwnershipArgs): Promise<ToolResult> {
  try {
    const kb = await getOrCreateKnowledgeBase();
    const entries = await getOwnership(kb, args.file);

    if (entries.length === 0) {
      return textResult(`No ownership data found for "${args.file}". Run \`grafema git-ingest\` first.`);
    }

    const lines: string[] = [`## Ownership of ${args.file} (${entries.length} authors)\n`];
    for (const entry of entries) {
      lines.push(`${entry.commits} commits | +${entry.linesAdded} -${entry.linesRemoved} | ${entry.authorName} (${entry.authorId})`);
    }

    return textResult(lines.join('\n'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResult(`Failed to get ownership data: ${message}`);
  }
}

/**
 * Get archaeology — temporal context for a file.
 */
export async function handleGitArchaeology(args: GitArchaeologyArgs): Promise<ToolResult> {
  try {
    const kb = await getOrCreateKnowledgeBase();
    const entry = await getArchaeology(kb, args.file);

    if (!entry.lastCommitHash) {
      return textResult(`No history found for "${args.file}". Run \`grafema git-ingest\` first.`);
    }

    const lines: string[] = [
      `## Archaeology: ${args.file}\n`,
      `First commit: ${entry.firstCommitDate} by ${entry.firstAuthor}`,
      `Last commit:  ${entry.lastCommitDate} by ${entry.lastAuthor} (${entry.lastCommitHash.slice(0, 8)})`,
    ];

    return textResult(lines.join('\n'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResult(`Failed to get archaeology data: ${message}`);
  }
}
