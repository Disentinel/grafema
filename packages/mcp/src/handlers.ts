/**
 * MCP Tool Handlers
 */

import { join } from 'path';
import { ensureAnalyzed } from './analysis.js';
import { getProjectPath, getAnalysisStatus, getOrCreateBackend, getGuaranteeManager, getGuaranteeAPI, isAnalysisRunning } from './state.js';
import {
  normalizeLimit,
  formatPaginationInfo,
  guardResponseSize,
  serializeBigInt,
  findSimilarTypes,
  textResult,
  errorResult,
} from './utils.js';
import type {
  ToolResult,
  QueryGraphArgs,
  FindCallsArgs,
  FindNodesArgs,
  TraceAliasArgs,
  TraceDataFlowArgs,
  CheckInvariantArgs,
  AnalyzeProjectArgs,
  GetSchemaArgs,
  CreateGuaranteeArgs,
  CheckGuaranteesArgs,
  DeleteGuaranteeArgs,
  GetCoverageArgs,
  GetDocumentationArgs,
  GraphBackend,
  GraphNode,
} from './types.js';
import { isGuaranteeType } from '@grafema/core';

// === QUERY HANDLERS ===

export async function handleQueryGraph(args: QueryGraphArgs): Promise<ToolResult> {
  const db = await ensureAnalyzed();
  const { query, limit: requestedLimit, offset: requestedOffset, format } = args;
  const explain = (args as any).explain;

  const limit = normalizeLimit(requestedLimit);
  const offset = Math.max(0, requestedOffset || 0);

  try {
    // Check if backend supports Datalog queries
    if (!('checkGuarantee' in db)) {
      return errorResult('Backend does not support Datalog queries');
    }

    const checkFn = (db as unknown as { checkGuarantee: (q: string) => Promise<Array<{ bindings: Array<{ name: string; value: string }> }>> }).checkGuarantee;
    const results = await checkFn(query);
    const total = results.length;

    if (total === 0) {
      const nodeCounts = await db.countNodesByType();
      const totalNodes = Object.values(nodeCounts).reduce((a, b) => a + b, 0);

      const typeMatch = query.match(/node\([^,]+,\s*"([^"]+)"\)/);
      const queriedType = typeMatch ? typeMatch[1] : null;

      let hint = '';
      if (queriedType && !nodeCounts[queriedType]) {
        const availableTypes = Object.keys(nodeCounts);
        const similar = findSimilarTypes(queriedType, availableTypes);
        if (similar.length > 0) {
          hint = `\n💡 Did you mean: ${similar.join(', ')}?`;
        } else {
          hint = `\n💡 Available types: ${availableTypes.slice(0, 10).join(', ')}${availableTypes.length > 10 ? '...' : ''}`;
        }
      }

      return textResult(
        `Query returned no results.${hint}\n📊 Graph: ${totalNodes.toLocaleString()} nodes`
      );
    }

    const paginatedResults = results.slice(offset, offset + limit);
    const hasMore = offset + limit < total;

    const enrichedResults: unknown[] = [];
    for (const result of paginatedResults) {
      const nodeId = result.bindings?.find((b: any) => b.name === 'X')?.value;
      if (nodeId) {
        const node = await db.getNode(nodeId);
        if (node) {
          enrichedResults.push({
            ...node,
            id: nodeId,
            file: node.file,
            line: node.line,
          });
        }
      }
    }

    const paginationInfo = formatPaginationInfo({
      limit,
      offset,
      returned: enrichedResults.length,
      total,
      hasMore,
    });

    const responseText = `Found ${total} result(s):${paginationInfo}\n\n${JSON.stringify(
      serializeBigInt(enrichedResults),
      null,
      2
    )}`;

    return textResult(guardResponseSize(responseText));
  } catch (error) {
    return errorResult((error as Error).message);
  }
}

export async function handleFindCalls(args: FindCallsArgs): Promise<ToolResult> {
  const db = await ensureAnalyzed();
  const { target: name, limit: requestedLimit, offset: requestedOffset } = args;
  const className = (args as any).className;

  const limit = normalizeLimit(requestedLimit);
  const offset = Math.max(0, requestedOffset || 0);

  const calls: unknown[] = [];
  let skipped = 0;
  let totalMatched = 0;

  for await (const node of db.queryNodes({ type: 'CALL' })) {
    if ((node as any).name !== name && (node as any).method !== name) continue;
    if (className && (node as any).object !== className) continue;

    totalMatched++;

    if (skipped < offset) {
      skipped++;
      continue;
    }

    if (calls.length >= limit) continue;

    const callsEdges = await db.getOutgoingEdges(node.id, ['CALLS']);
    const isResolved = callsEdges.length > 0;

    let target = null;
    if (isResolved) {
      const targetNode = await db.getNode(callsEdges[0].dst);
      target = targetNode
        ? {
            type: targetNode.type,
            name: targetNode.name,
            file: targetNode.file,
            line: targetNode.line,
          }
        : null;
    }

    calls.push({
      id: node.id,
      name: (node as any).name,
      object: (node as any).object,
      file: node.file,
      line: node.line,
      resolved: isResolved,
      target,
    });
  }

  if (totalMatched === 0) {
    return textResult(`No calls found for "${className ? className + '.' : ''}${name}"`);
  }

  const resolved = calls.filter((c: any) => c.resolved).length;
  const unresolved = calls.length - resolved;
  const hasMore = offset + calls.length < totalMatched;

  const paginationInfo = formatPaginationInfo({
    limit,
    offset,
    returned: calls.length,
    total: totalMatched,
    hasMore,
  });

  const responseText =
    `Found ${totalMatched} call(s) to "${className ? className + '.' : ''}${name}":${paginationInfo}\n` +
    `- Resolved: ${resolved}\n` +
    `- Unresolved: ${unresolved}\n\n` +
    JSON.stringify(serializeBigInt(calls), null, 2);

  return textResult(guardResponseSize(responseText));
}

export async function handleFindNodes(args: FindNodesArgs): Promise<ToolResult> {
  const db = await ensureAnalyzed();
  const { type, name, file, limit: requestedLimit, offset: requestedOffset } = args;

  const limit = normalizeLimit(requestedLimit);
  const offset = Math.max(0, requestedOffset || 0);

  const filter: Record<string, unknown> = {};
  if (type) filter.type = type;
  if (name) filter.name = name;
  if (file) filter.file = file;

  const nodes: GraphNode[] = [];
  let skipped = 0;
  let totalMatched = 0;

  for await (const node of db.queryNodes(filter)) {
    totalMatched++;

    if (skipped < offset) {
      skipped++;
      continue;
    }

    if (nodes.length < limit) {
      nodes.push(node);
    }
  }

  if (totalMatched === 0) {
    return textResult('No nodes found matching criteria');
  }

  const hasMore = offset + nodes.length < totalMatched;
  const paginationInfo = formatPaginationInfo({
    limit,
    offset,
    returned: nodes.length,
    total: totalMatched,
    hasMore,
  });

  return textResult(
    `Found ${totalMatched} node(s):${paginationInfo}\n\n${JSON.stringify(
      serializeBigInt(nodes),
      null,
      2
    )}`
  );
}

// === TRACE HANDLERS ===

export async function handleTraceAlias(args: TraceAliasArgs): Promise<ToolResult> {
  const db = await ensureAnalyzed();
  const { variableName, file } = args;
  const projectPath = getProjectPath();

  let varNode: GraphNode | null = null;

  for await (const node of db.queryNodes({ type: 'VARIABLE' })) {
    if (node.name === variableName && node.file?.includes(file || '')) {
      varNode = node;
      break;
    }
  }

  if (!varNode) {
    for await (const node of db.queryNodes({ type: 'CONSTANT' })) {
      if (node.name === variableName && node.file?.includes(file || '')) {
        varNode = node;
        break;
      }
    }
  }

  if (!varNode) {
    return errorResult(`Variable "${variableName}" not found in ${file || 'project'}`);
  }

  const chain: unknown[] = [];
  const visited = new Set<string>();
  let current: GraphNode | null = varNode;
  const MAX_DEPTH = 20;

  while (current && chain.length < MAX_DEPTH) {
    if (visited.has(current.id)) {
      chain.push({ type: 'CYCLE_DETECTED', id: current.id });
      break;
    }
    visited.add(current.id);

    chain.push({
      type: current.type,
      name: current.name,
      file: current.file,
      line: current.line,
    });

    const edges = await db.getOutgoingEdges(current.id, ['ASSIGNED_FROM']);
    if (edges.length === 0) break;

    current = await db.getNode(edges[0].dst);
  }

  return textResult(
    `Alias chain for "${variableName}" (${chain.length} steps):\n\n${JSON.stringify(
      serializeBigInt(chain),
      null,
      2
    )}`
  );
}

export async function handleTraceDataFlow(args: TraceDataFlowArgs): Promise<ToolResult> {
  const db = await ensureAnalyzed();
  const { source, direction = 'forward', max_depth = 10 } = args;

  // Find source node
  let sourceNode: GraphNode | null = null;

  // Try to find by ID first
  sourceNode = await db.getNode(source);

  // If not found, search by name
  if (!sourceNode) {
    for await (const node of db.queryNodes({ name: source })) {
      sourceNode = node;
      break;
    }
  }

  if (!sourceNode) {
    return errorResult(`Source "${source}" not found`);
  }

  const visited = new Set<string>();
  const paths: unknown[] = [];

  async function trace(nodeId: string, depth: number, path: string[]): Promise<void> {
    if (depth > max_depth || visited.has(nodeId)) return;
    visited.add(nodeId);

    const newPath = [...path, nodeId];

    if (direction === 'forward' || direction === 'both') {
      const outEdges = await db.getOutgoingEdges(nodeId, [
        'ASSIGNED_FROM',
        'DERIVES_FROM',
        'PASSES_ARGUMENT',
      ]);
      for (const edge of outEdges) {
        await trace(edge.dst, depth + 1, newPath);
      }
    }

    if (direction === 'backward' || direction === 'both') {
      const inEdges = await db.getIncomingEdges(nodeId, [
        'ASSIGNED_FROM',
        'DERIVES_FROM',
        'PASSES_ARGUMENT',
      ]);
      for (const edge of inEdges) {
        await trace(edge.src, depth + 1, newPath);
      }
    }

    if (depth > 0) {
      paths.push(newPath);
    }
  }

  await trace(sourceNode.id, 0, []);

  return textResult(
    `Data flow from "${source}" (${paths.length} paths):\n\n${JSON.stringify(paths, null, 2)}`
  );
}

export async function handleCheckInvariant(args: CheckInvariantArgs): Promise<ToolResult> {
  const db = await ensureAnalyzed();
  const { rule, name: description } = args;

  if (!('checkGuarantee' in db)) {
    return errorResult('Backend does not support Datalog queries');
  }

  try {
    const checkFn = (db as unknown as { checkGuarantee: (q: string) => Promise<Array<{ bindings: Array<{ name: string; value: string }> }>> }).checkGuarantee;
    const violations = await checkFn(rule);
    const total = violations.length;

    if (total === 0) {
      return textResult(`✅ Invariant holds: ${description || 'No violations found'}`);
    }

    const enrichedViolations: unknown[] = [];
    for (const v of violations.slice(0, 20)) {
      const nodeId = v.bindings?.find((b: any) => b.name === 'X')?.value;
      if (nodeId) {
        const node = await db.getNode(nodeId);
        if (node) {
          enrichedViolations.push({
            id: nodeId,
            type: node.type,
            name: node.name,
            file: node.file,
            line: node.line,
          });
        }
      }
    }

    return textResult(
      `❌ ${total} violation(s) found:\n\n${JSON.stringify(
        serializeBigInt(enrichedViolations),
        null,
        2
      )}${total > 20 ? `\n\n... and ${total - 20} more` : ''}`
    );
  } catch (error) {
    return errorResult((error as Error).message);
  }
}

// === ANALYSIS HANDLERS ===

export async function handleAnalyzeProject(args: AnalyzeProjectArgs): Promise<ToolResult> {
  const { service, force } = args;

  // Early check: return error for force=true if analysis is already running
  // This provides immediate feedback instead of waiting or causing corruption
  if (force && isAnalysisRunning()) {
    return errorResult(
      'Cannot force re-analysis: analysis is already in progress. ' +
        'Use get_analysis_status to check current status, or wait for completion.'
    );
  }

  // Note: setIsAnalyzed(false) is now handled inside ensureAnalyzed() within the lock
  // to prevent race conditions where multiple calls could both clear the database

  try {
    await ensureAnalyzed(service || null, force || false);
    const status = getAnalysisStatus();

    return textResult(
      `Analysis complete!\n` +
        `- Services discovered: ${status.servicesDiscovered}\n` +
        `- Services analyzed: ${status.servicesAnalyzed}\n` +
        `- Total time: ${status.timings.total || 'N/A'}s`
    );
  } catch (error) {
    return errorResult((error as Error).message);
  }
}

export async function handleGetAnalysisStatus(): Promise<ToolResult> {
  const status = getAnalysisStatus();

  return textResult(
    `Analysis Status:\n` +
      `- Running: ${status.running}\n` +
      `- Phase: ${status.phase || 'N/A'}\n` +
      `- Message: ${status.message || 'N/A'}\n` +
      `- Services discovered: ${status.servicesDiscovered}\n` +
      `- Services analyzed: ${status.servicesAnalyzed}\n` +
      (status.error ? `- Error: ${status.error}\n` : '')
  );
}

export async function handleGetStats(): Promise<ToolResult> {
  const db = await getOrCreateBackend();

  const nodeCount = await db.nodeCount();
  const edgeCount = await db.edgeCount();
  const nodesByType = await db.countNodesByType();
  const edgesByType = await db.countEdgesByType();

  return textResult(
    `Graph Statistics:\n\n` +
      `Total nodes: ${nodeCount.toLocaleString()}\n` +
      `Total edges: ${edgeCount.toLocaleString()}\n\n` +
      `Nodes by type:\n${JSON.stringify(nodesByType, null, 2)}\n\n` +
      `Edges by type:\n${JSON.stringify(edgesByType, null, 2)}`
  );
}

export async function handleGetSchema(args: GetSchemaArgs): Promise<ToolResult> {
  const db = await getOrCreateBackend();
  const { type = 'all' } = args;

  const nodesByType = await db.countNodesByType();
  const edgesByType = await db.countEdgesByType();

  let output = '';

  if (type === 'nodes' || type === 'all') {
    output += `Node Types (${Object.keys(nodesByType).length}):\n`;
    for (const [t, count] of Object.entries(nodesByType)) {
      output += `  - ${t}: ${count}\n`;
    }
  }

  if (type === 'edges' || type === 'all') {
    output += `\nEdge Types (${Object.keys(edgesByType).length}):\n`;
    for (const [t, count] of Object.entries(edgesByType)) {
      output += `  - ${t}: ${count}\n`;
    }
  }

  return textResult(output);
}

// === GUARANTEE HANDLERS ===

/**
 * Create a new guarantee (Datalog-based or contract-based)
 */
export async function handleCreateGuarantee(args: CreateGuaranteeArgs): Promise<ToolResult> {
  await getOrCreateBackend(); // Ensure managers are initialized

  const { name, rule, type, priority, status, owner, schema, condition, description, governs, severity } = args;

  try {
    // Determine if this is a contract-based guarantee
    if (type && isGuaranteeType(type)) {
      // Contract-based guarantee
      const api = getGuaranteeAPI();
      if (!api) {
        return errorResult('GuaranteeAPI not initialized');
      }

      const guarantee = await api.createGuarantee({
        type,
        name,
        priority,
        status,
        owner,
        schema,
        condition,
        description,
        governs,
      });

      return textResult(
        `✅ Created contract-based guarantee: ${guarantee.id}\n` +
        `Type: ${guarantee.type}\n` +
        `Priority: ${guarantee.priority}\n` +
        `Status: ${guarantee.status}` +
        (guarantee.description ? `\nDescription: ${guarantee.description}` : '')
      );
    } else {
      // Datalog-based guarantee
      if (!rule) {
        return errorResult('Datalog-based guarantee requires "rule" field');
      }

      const manager = getGuaranteeManager();
      if (!manager) {
        return errorResult('GuaranteeManager not initialized');
      }

      const guarantee = await manager.create({
        id: name,
        name,
        rule,
        severity: severity || 'warning',
        governs: governs || ['**/*.js'],
      });

      return textResult(
        `✅ Created Datalog-based guarantee: ${guarantee.id}\n` +
        `Rule: ${guarantee.rule}\n` +
        `Severity: ${guarantee.severity}`
      );
    }
  } catch (error) {
    return errorResult(`Failed to create guarantee: ${(error as Error).message}`);
  }
}

/**
 * List all guarantees (both Datalog-based and contract-based)
 */
export async function handleListGuarantees(): Promise<ToolResult> {
  await getOrCreateBackend(); // Ensure managers are initialized

  const results: string[] = [];

  try {
    // List Datalog-based guarantees
    const manager = getGuaranteeManager();
    if (manager) {
      const datalogGuarantees = await manager.list();
      if (datalogGuarantees.length > 0) {
        results.push('## Datalog-based Guarantees\n');
        for (const g of datalogGuarantees) {
          results.push(`- **${g.id}** (${g.severity})`);
          results.push(`  Rule: ${g.rule.substring(0, 80)}${g.rule.length > 80 ? '...' : ''}`);
        }
      }
    }

    // List contract-based guarantees
    const api = getGuaranteeAPI();
    if (api) {
      const contractGuarantees = await api.findGuarantees();
      if (contractGuarantees.length > 0) {
        if (results.length > 0) results.push('\n');
        results.push('## Contract-based Guarantees\n');
        for (const g of contractGuarantees) {
          results.push(`- **${g.id}** [${g.priority}] (${g.status})`);
          if (g.description) results.push(`  ${g.description}`);
        }
      }
    }

    if (results.length === 0) {
      return textResult('No guarantees defined yet.');
    }

    return textResult(results.join('\n'));
  } catch (error) {
    return errorResult(`Failed to list guarantees: ${(error as Error).message}`);
  }
}

/**
 * Check guarantees (both Datalog-based and contract-based)
 */
export async function handleCheckGuarantees(args: CheckGuaranteesArgs): Promise<ToolResult> {
  await getOrCreateBackend(); // Ensure managers are initialized

  const { names } = args;
  const results: string[] = [];
  let totalPassed = 0;
  let totalFailed = 0;

  try {
    const manager = getGuaranteeManager();
    const api = getGuaranteeAPI();

    if (names && names.length > 0) {
      // Check specific guarantees
      for (const name of names) {
        // Try Datalog-based first
        if (manager) {
          try {
            const result = await manager.check(name);
            if (result.passed) {
              totalPassed++;
              results.push(`✅ ${result.guaranteeId}: PASSED`);
            } else {
              totalFailed++;
              results.push(`❌ ${result.guaranteeId}: FAILED (${result.violationCount} violations)`);
              for (const v of result.violations.slice(0, 5)) {
                results.push(`   - ${v.file}:${v.line} (${v.type})`);
              }
              if (result.violationCount > 5) {
                results.push(`   ... and ${result.violationCount - 5} more`);
              }
            }
            continue;
          } catch {
            // Not a Datalog guarantee, try contract-based
          }
        }

        // Try contract-based
        if (api) {
          try {
            const result = await api.checkGuarantee(name);
            if (result.passed) {
              totalPassed++;
              results.push(`✅ ${result.id}: PASSED`);
            } else {
              totalFailed++;
              results.push(`❌ ${result.id}: FAILED`);
              for (const err of result.errors.slice(0, 5)) {
                results.push(`   - ${err}`);
              }
            }
          } catch {
            results.push(`⚠️ ${name}: Not found`);
          }
        }
      }
    } else {
      // Check all guarantees
      if (manager) {
        const datalogResult = await manager.checkAll();
        totalPassed += datalogResult.passed;
        totalFailed += datalogResult.failed;

        if (datalogResult.total > 0) {
          results.push('## Datalog Guarantees\n');
          for (const r of datalogResult.results) {
            if (r.passed) {
              results.push(`✅ ${r.guaranteeId}: PASSED`);
            } else {
              results.push(`❌ ${r.guaranteeId}: FAILED (${r.violationCount} violations)`);
            }
          }
        }
      }

      if (api) {
        const contractResult = await api.checkAllGuarantees();
        totalPassed += contractResult.passed;
        totalFailed += contractResult.failed;

        if (contractResult.total > 0) {
          if (results.length > 0) results.push('\n');
          results.push('## Contract Guarantees\n');
          for (const r of contractResult.results) {
            if (r.passed) {
              results.push(`✅ ${r.id}: PASSED`);
            } else {
              results.push(`❌ ${r.id}: FAILED`);
            }
          }
        }
      }
    }

    if (results.length === 0) {
      return textResult('No guarantees to check.');
    }

    const summary = `\n---\nTotal: ${totalPassed + totalFailed} | ✅ Passed: ${totalPassed} | ❌ Failed: ${totalFailed}`;
    return textResult(results.join('\n') + summary);
  } catch (error) {
    return errorResult(`Failed to check guarantees: ${(error as Error).message}`);
  }
}

/**
 * Delete a guarantee
 */
export async function handleDeleteGuarantee(args: DeleteGuaranteeArgs): Promise<ToolResult> {
  await getOrCreateBackend(); // Ensure managers are initialized

  const { name } = args;

  try {
    // Try Datalog-based first
    const manager = getGuaranteeManager();
    if (manager) {
      try {
        await manager.delete(name);
        return textResult(`✅ Deleted Datalog guarantee: ${name}`);
      } catch {
        // Not found in Datalog, try contract-based
      }
    }

    // Try contract-based
    const api = getGuaranteeAPI();
    if (api) {
      const deleted = await api.deleteGuarantee(name);
      if (deleted) {
        return textResult(`✅ Deleted contract guarantee: ${name}`);
      }
    }

    return errorResult(`Guarantee not found: ${name}`);
  } catch (error) {
    return errorResult(`Failed to delete guarantee: ${(error as Error).message}`);
  }
}

// === COVERAGE & DOCS ===

export async function handleGetCoverage(args: GetCoverageArgs): Promise<ToolResult> {
  const db = await getOrCreateBackend();
  const projectPath = getProjectPath();
  const { path: targetPath = projectPath } = args;

  const nodeCount = await db.nodeCount();
  const moduleNodes = db.findByType ? await db.findByType('MODULE') : [];

  return textResult(
    `Coverage for ${targetPath}:\n` +
      `- Analyzed files: ${moduleNodes.length}\n` +
      `- Total nodes: ${nodeCount}\n`
  );
}

export async function handleGetDocumentation(args: GetDocumentationArgs): Promise<ToolResult> {
  const { topic = 'overview' } = args;

  const docs: Record<string, string> = {
    overview: `
# Grafema Code Analysis

Grafema is a static code analyzer that builds a graph of your codebase.

## Key Tools
- query_graph: Execute Datalog queries
- find_calls: Find function/method calls
- trace_alias: Trace variable aliases
- check_invariant: Verify code invariants

## Quick Start
1. Use get_stats to see graph size
2. Use find_nodes to explore the codebase
3. Use query_graph for complex queries
`,
    queries: `
# Datalog Queries

## Syntax
violation(X) :- node(X, "TYPE"), attr(X, "name", "value").

## Available Predicates
- node(Id, Type) - match nodes
- edge(Src, Dst, Type) - match edges
- attr(Id, Name, Value) - match attributes
- \\+ - negation (not)

## Examples
Find all functions:
  violation(X) :- node(X, "FUNCTION").

Find unresolved calls:
  violation(X) :- node(X, "CALL"), \\+ edge(X, _, "CALLS").
`,
    types: `
# Node & Edge Types

## Core Node Types
- MODULE, FUNCTION, CLASS, METHOD, VARIABLE
- CALL, IMPORT, EXPORT, PARAMETER

## HTTP/Network
- http:route, http:request, db:query

## Edge Types
- CONTAINS, CALLS, DEPENDS_ON
- ASSIGNED_FROM, INSTANCE_OF, PASSES_ARGUMENT
`,
    guarantees: `
# Code Guarantees

Guarantees are persistent code invariants.

## Create
Use create_guarantee with a name and Datalog rule.

## Check
Use check_guarantees to verify all guarantees.

## Example
Name: no-eval
Rule: violation(X) :- node(X, "CALL"), attr(X, "name", "eval").
`,
  };

  const content = docs[topic] || docs.overview;
  return textResult(content.trim());
}

// === BUG REPORTING ===

export async function handleReportIssue(args: import('./types.js').ReportIssueArgs): Promise<ToolResult> {
  const { title, description, context, labels = ['bug'] } = args;
  // Use user's token if provided, otherwise fall back to project's issue-only token
  const GRAFEMA_ISSUE_TOKEN = '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';
  const githubToken = process.env.GITHUB_TOKEN || GRAFEMA_ISSUE_TOKEN;
  const repo = 'Disentinel/grafema';

  // Build issue body
  const body = `## Description
${description}

${context ? `## Context\n\`\`\`\n${context}\n\`\`\`\n` : ''}
## Environment
- Grafema version: 0.1.0-alpha.1
- Reported via: MCP tool

---
*This issue was automatically created via Grafema MCP server.*`;

  // Try GitHub API if token is available
  if (githubToken) {
    try {
      const response = await fetch(`https://api.github.com/repos/${repo}/issues`, {
        method: 'POST',
        headers: {
          'Authorization': `token ${githubToken}`,
          'Content-Type': 'application/json',
          'Accept': 'application/vnd.github.v3+json',
        },
        body: JSON.stringify({
          title,
          body,
          labels: labels.filter(l => ['bug', 'enhancement', 'documentation', 'question'].includes(l)),
        }),
      });

      if (response.ok) {
        const issue = await response.json() as { html_url: string; number: number };
        return textResult(
          `✅ Issue created successfully!\n\n` +
          `**Issue #${issue.number}**: ${issue.html_url}\n\n` +
          `Thank you for reporting this issue.`
        );
      } else {
        const error = await response.text();
        throw new Error(`GitHub API error: ${response.status} - ${error}`);
      }
    } catch (error) {
      // Fall through to manual template if API fails
      console.error('[report_issue] GitHub API failed:', error);
    }
  }

  // Fallback: return template for manual submission
  const issueUrl = `https://github.com/${repo}/issues/new`;
  const encodedTitle = encodeURIComponent(title);
  const encodedBody = encodeURIComponent(body);
  const encodedLabels = encodeURIComponent(labels.join(','));
  const directUrl = `${issueUrl}?title=${encodedTitle}&body=${encodedBody}&labels=${encodedLabels}`;

  return textResult(
    `⚠️ Failed to create issue automatically. Please create it manually:\n\n` +
    `**Quick link** (may truncate long descriptions):\n${directUrl}\n\n` +
    `**Or copy this template to** ${issueUrl}:\n\n` +
    `---\n**Title:** ${title}\n\n${body}\n---`
  );
}
