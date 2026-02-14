/**
 * MCP Tool Handlers
 */

import { ensureAnalyzed } from './analysis.js';
import { getProjectPath, getAnalysisStatus, getOrCreateBackend, getGuaranteeManager, getGuaranteeAPI, isAnalysisRunning } from './state.js';
import { CoverageAnalyzer, findCallsInFunction, findContainingFunction, validateServices, validatePatterns, validateWorkspace, getOnboardingInstruction, GRAFEMA_VERSION, getSchemaVersion } from '@grafema/core';
import type { CallInfo, CallerInfo } from '@grafema/core';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'fs';
import type { Dirent } from 'fs';
import { isAbsolute, join, basename, relative } from 'path';
import { stringify as stringifyYAML } from 'yaml';
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
  FindGuardsArgs,
  GuardInfo,
  GetFunctionDetailsArgs,
  GetContextArgs,
  GraphNode,
  DatalogBinding,
  CallResult,
  ReportIssueArgs,
  ReadProjectStructureArgs,
  WriteConfigArgs,
} from './types.js';
import { isGuaranteeType } from '@grafema/core';

// === QUERY HANDLERS ===

export async function handleQueryGraph(args: QueryGraphArgs): Promise<ToolResult> {
  const db = await ensureAnalyzed();
  const { query, limit: requestedLimit, offset: requestedOffset, format: _format, explain: _explain } = args;

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
      const nodeId = result.bindings?.find((b: DatalogBinding) => b.name === 'X')?.value;
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
    const message = error instanceof Error ? error.message : String(error);
    return errorResult(message);
  }
}

export async function handleFindCalls(args: FindCallsArgs): Promise<ToolResult> {
  const db = await ensureAnalyzed();
  const { target: name, limit: requestedLimit, offset: requestedOffset, className } = args;

  const limit = normalizeLimit(requestedLimit);
  const offset = Math.max(0, requestedOffset || 0);

  const calls: CallResult[] = [];
  let skipped = 0;
  let totalMatched = 0;

  for await (const node of db.queryNodes({ type: 'CALL' })) {
    if (node.name !== name && node['method'] !== name) continue;
    if (className && node['object'] !== className) continue;

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
            name: targetNode.name ?? '',
            file: targetNode.file,
            line: targetNode.line,
          }
        : null;
    }

    calls.push({
      id: node.id,
      name: node.name,
      object: node['object'] as string | undefined,
      file: node.file,
      line: node.line,
      resolved: isResolved,
      target,
    });
  }

  if (totalMatched === 0) {
    return textResult(`No calls found for "${className ? className + '.' : ''}${name}"`);
  }

  const resolved = calls.filter(c => c.resolved).length;
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
  const _projectPath = getProjectPath();

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
    const message = error instanceof Error ? error.message : String(error);
    return errorResult(message);
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
    const message = error instanceof Error ? error.message : String(error);
    return errorResult(message);
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
    const message = error instanceof Error ? error.message : String(error);
    return errorResult(`Failed to create guarantee: ${message}`);
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
    const message = error instanceof Error ? error.message : String(error);
    return errorResult(`Failed to list guarantees: ${message}`);
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
    const message = error instanceof Error ? error.message : String(error);
    return errorResult(`Failed to check guarantees: ${message}`);
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
    const message = error instanceof Error ? error.message : String(error);
    return errorResult(`Failed to delete guarantee: ${message}`);
  }
}

// === COVERAGE & DOCS ===

export async function handleGetCoverage(args: GetCoverageArgs): Promise<ToolResult> {
  const db = await getOrCreateBackend();
  const projectPath = getProjectPath();
  const { path: targetPath = projectPath } = args;

  try {
    const analyzer = new CoverageAnalyzer(db, targetPath);
    const result = await analyzer.analyze();

    // Format output for AI agents
    let output = `Analysis Coverage for ${targetPath}\n`;
    output += `==============================\n\n`;

    output += `File breakdown:\n`;
    output += `  Total files:     ${result.total}\n`;
    output += `  Analyzed:        ${result.analyzed.count} (${result.percentages.analyzed}%) - in graph\n`;
    output += `  Unsupported:     ${result.unsupported.count} (${result.percentages.unsupported}%) - no indexer available\n`;
    output += `  Unreachable:     ${result.unreachable.count} (${result.percentages.unreachable}%) - not imported from entrypoints\n`;

    if (result.unsupported.count > 0) {
      output += `\nUnsupported files by extension:\n`;
      for (const [ext, files] of Object.entries(result.unsupported.byExtension)) {
        output += `  ${ext}: ${files.length} files\n`;
      }
    }

    if (result.unreachable.count > 0) {
      output += `\nUnreachable source files:\n`;
      for (const [ext, files] of Object.entries(result.unreachable.byExtension)) {
        output += `  ${ext}: ${files.length} files\n`;
      }
    }

    return textResult(output);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResult(`Failed to calculate coverage: ${message}`);
  }
}

export async function handleGetDocumentation(args: GetDocumentationArgs): Promise<ToolResult> {
  const { topic = 'overview' } = args;

  const docs: Record<string, string> = {
    onboarding: getOnboardingInstruction(),
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
- CALL, PROPERTY_ACCESS, IMPORT, EXPORT, PARAMETER

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

// === FIND GUARDS (REG-274) ===

/**
 * Find conditional guards protecting a node.
 *
 * Walks up the containment tree via CONTAINS edges, collecting
 * SCOPE nodes that have conditional=true (if_statement, else_statement, etc.).
 *
 * Returns guards in inner-to-outer order.
 */
export async function handleFindGuards(args: FindGuardsArgs): Promise<ToolResult> {
  const db = await getOrCreateBackend();
  const { nodeId } = args;

  // Verify target node exists
  const targetNode = await db.getNode(nodeId);
  if (!targetNode) {
    return errorResult(`Node not found: ${nodeId}`);
  }

  const guards: GuardInfo[] = [];
  const visited = new Set<string>();
  let currentId = nodeId;

  // Walk up the containment tree
  while (true) {
    if (visited.has(currentId)) break;
    visited.add(currentId);

    // Get parent via incoming CONTAINS edge
    const incomingEdges = await db.getIncomingEdges(currentId, ['CONTAINS']);
    if (incomingEdges.length === 0) break;

    const parentId = incomingEdges[0].src;
    const parentNode = await db.getNode(parentId);

    if (!parentNode) break;

    // Check if this is a conditional scope
    if (parentNode.conditional) {
      // Parse constraints if stored as string
      let constraints = parentNode.constraints;
      if (typeof constraints === 'string') {
        try {
          constraints = JSON.parse(constraints);
        } catch {
          // Keep as string if not valid JSON
        }
      }

      guards.push({
        scopeId: parentNode.id,
        scopeType: (parentNode.scopeType as string) || 'unknown',
        condition: parentNode.condition as string | undefined,
        constraints: constraints as unknown[] | undefined,
        file: parentNode.file || '',
        line: (parentNode.line as number) || 0,
      });
    }

    currentId = parentId;
  }

  if (guards.length === 0) {
    return textResult(
      `No guards found for node: ${nodeId}\n` +
      `The node is not protected by any conditional scope (if/else/switch/etc.).`
    );
  }

  const summary = guards.map((g, i) => {
    const indent = '  '.repeat(i);
    return `${indent}${i + 1}. ${g.scopeType} at ${g.file}:${g.line}` +
      (g.condition ? `\n${indent}   condition: ${g.condition}` : '');
  }).join('\n');

  return textResult(
    `Found ${guards.length} guard(s) for node: ${nodeId}\n` +
    `(inner to outer order)\n\n` +
    summary +
    `\n\n` +
    JSON.stringify(serializeBigInt(guards), null, 2)
  );
}

// === GET FUNCTION DETAILS (REG-254) ===

/**
 * Get comprehensive function details including calls made and callers.
 *
 * Graph structure:
 * ```
 * FUNCTION -[HAS_SCOPE]-> SCOPE -[CONTAINS]-> CALL/METHOD_CALL
 *                         SCOPE -[CONTAINS]-> SCOPE (nested blocks)
 * CALL -[CALLS]-> FUNCTION (target)
 * ```
 *
 * This is the core tool for understanding function behavior.
 * Use transitive=true to follow call chains (A -> B -> C).
 */
export async function handleGetFunctionDetails(
  args: GetFunctionDetailsArgs
): Promise<ToolResult> {
  const db = await ensureAnalyzed();
  const { name, file, transitive = false } = args;

  // Step 1: Find the function
  const candidates: GraphNode[] = [];
  for await (const node of db.queryNodes({ type: 'FUNCTION' })) {
    if (node.name !== name) continue;
    if (file && !node.file?.includes(file)) continue;
    candidates.push(node);
  }

  if (candidates.length === 0) {
    return errorResult(
      `Function "${name}" not found.` +
      (file ? ` (searched in files matching "${file}")` : '')
    );
  }

  if (candidates.length > 1 && !file) {
    const locations = candidates.map(f => `${f.file}:${f.line}`).join(', ');
    return errorResult(
      `Multiple functions named "${name}" found: ${locations}. ` +
      `Use the "file" parameter to disambiguate.`
    );
  }

  const targetFunction = candidates[0];

  // Step 2: Find calls using shared utility
  const calls = await findCallsInFunction(db, targetFunction.id, {
    transitive,
    transitiveDepth: 5,
  });

  // Step 3: Find callers
  const calledBy: CallerInfo[] = [];
  const incomingCalls = await db.getIncomingEdges(targetFunction.id, ['CALLS']);
  const seenCallers = new Set<string>();

  for (const edge of incomingCalls) {
    const caller = await findContainingFunction(db, edge.src);
    if (caller && !seenCallers.has(caller.id)) {
      seenCallers.add(caller.id);
      calledBy.push(caller);
    }
  }

  // Step 4: Build result
  const result = {
    id: targetFunction.id,
    name: targetFunction.name,
    file: targetFunction.file,
    line: targetFunction.line as number | undefined,
    async: targetFunction.async as boolean | undefined,
    calls,
    calledBy,
  };

  // Format output
  const summary = [
    `Function: ${result.name}`,
    `File: ${result.file || 'unknown'}:${result.line || '?'}`,
    `Async: ${result.async || false}`,
    `Transitive: ${transitive}`,
    '',
    `Calls (${calls.length}):`,
    ...formatCallsForDisplay(calls),
    '',
    `Called by (${calledBy.length}):`,
    ...calledBy.map(c => `  - ${c.name} (${c.file}:${c.line})`),
  ].join('\n');

  return textResult(
    summary + '\n\n' +
    JSON.stringify(serializeBigInt(result), null, 2)
  );
}

/**
 * Format calls for display, grouped by depth if transitive
 */
function formatCallsForDisplay(calls: CallInfo[]): string[] {
  const directCalls = calls.filter(c => (c.depth || 0) === 0);
  const transitiveCalls = calls.filter(c => (c.depth || 0) > 0);

  const lines: string[] = [];

  // Direct calls
  for (const c of directCalls) {
    const target = c.resolved
      ? ` -> ${c.target?.name} (${c.target?.file}:${c.target?.line})`
      : ' (unresolved)';
    const prefix = c.type === 'METHOD_CALL' ? `${c.object}.` : '';
    lines.push(`  - ${prefix}${c.name}()${target}`);
  }

  // Transitive calls (grouped by depth)
  if (transitiveCalls.length > 0) {
    lines.push('');
    lines.push('  Transitive calls:');

    const byDepth = new Map<number, CallInfo[]>();
    for (const c of transitiveCalls) {
      const depth = c.depth || 1;
      if (!byDepth.has(depth)) byDepth.set(depth, []);
      byDepth.get(depth)!.push(c);
    }

    for (const [depth, depthCalls] of Array.from(byDepth.entries()).sort((a, b) => a[0] - b[0])) {
      for (const c of depthCalls) {
        const indent = '  '.repeat(depth + 1);
        const prefix = c.type === 'METHOD_CALL' ? `${c.object}.` : '';
        const target = c.resolved ? ` -> ${c.target?.name}` : '';
        lines.push(`${indent}[depth=${depth}] ${prefix}${c.name}()${target}`);
      }
    }
  }

  return lines;
}

// === NODE CONTEXT (REG-406) ===

/**
 * Structural edge types — shown in compact form (no code context)
 */
const CONTEXT_STRUCTURAL_EDGES = new Set([
  'CONTAINS', 'HAS_SCOPE', 'DECLARES', 'DEFINES',
  'HAS_CONDITION', 'HAS_CASE', 'HAS_DEFAULT',
  'HAS_CONSEQUENT', 'HAS_ALTERNATE', 'HAS_BODY',
  'HAS_INIT', 'HAS_UPDATE', 'HAS_CATCH', 'HAS_FINALLY',
  'HAS_PARAMETER', 'HAS_PROPERTY', 'HAS_ELEMENT',
  'USES', 'GOVERNS', 'VIOLATES', 'AFFECTS', 'UNKNOWN',
]);

export async function handleGetContext(
  args: GetContextArgs
): Promise<ToolResult> {
  const db = await ensureAnalyzed();
  const { semanticId, contextLines: ctxLines = 3, edgeType } = args;

  // 1. Look up node
  const node = await db.getNode(semanticId);
  if (!node) {
    return errorResult(
      `Node not found: "${semanticId}"\n` +
      `Use find_nodes or query_graph to find the correct semantic ID.`
    );
  }

  const edgeTypeFilter = edgeType
    ? new Set(edgeType.split(',').map(t => t.trim().toUpperCase()))
    : null;

  // 2. Get source code
  const projectPath = getProjectPath();
  let sourcePreview: { file: string; startLine: number; endLine: number; lines: string[] } | null = null;
  if (node.file && node.line) {
    const absoluteFile = !isAbsolute(node.file) ? join(projectPath, node.file) : node.file;
    if (existsSync(absoluteFile)) {
      try {
        const content = readFileSync(absoluteFile, 'utf-8');
        const allLines = content.split('\n');
        const line = node.line as number;
        const startLine = Math.max(1, line - ctxLines);
        const endLine = Math.min(allLines.length, line + ctxLines + 12);
        sourcePreview = {
          file: node.file,
          startLine,
          endLine,
          lines: allLines.slice(startLine - 1, endLine),
        };
      } catch { /* ignore */ }
    }
  }

  // 3. Get edges
  const rawOutgoing = await db.getOutgoingEdges(node.id);
  const rawIncoming = await db.getIncomingEdges(node.id);

  // Filter edges
  const outgoing = edgeTypeFilter
    ? rawOutgoing.filter(e => edgeTypeFilter.has(e.type || 'UNKNOWN'))
    : rawOutgoing;
  const incoming = edgeTypeFilter
    ? rawIncoming.filter(e => edgeTypeFilter.has(e.type || 'UNKNOWN'))
    : rawIncoming;

  // 4. Resolve connected nodes (grouped by edge type)
  type ResolvedEdge = { edge: { src: string; dst: string; type: string }; node: GraphNode | null };
  const resolveEdges = async (edges: Array<{ src: string; dst: string; type: string }>, field: 'src' | 'dst') => {
    const grouped = new Map<string, ResolvedEdge[]>();
    for (const edge of edges) {
      const connectedNode = await db.getNode(edge[field]);
      const type = edge.type || 'UNKNOWN';
      if (!grouped.has(type)) grouped.set(type, []);
      grouped.get(type)!.push({ edge, node: connectedNode });
    }
    return Object.fromEntries(
      Array.from(grouped.entries()).sort(([a], [b]) => a.localeCompare(b))
    );
  };

  const outgoingGrouped = await resolveEdges(outgoing, 'dst');
  const incomingGrouped = await resolveEdges(incoming, 'src');

  // 5. Format text output
  const relFile = node.file ? (isAbsolute(node.file) ? relative(projectPath, node.file) : node.file) : undefined;
  const lines: string[] = [];

  lines.push(`[${node.type}] ${node.name || node.id}`);
  lines.push(`  ID: ${node.id}`);
  if (relFile) {
    lines.push(`  Location: ${relFile}${node.line ? `:${node.line}` : ''}`);
  }

  // Source
  if (sourcePreview) {
    lines.push('');
    lines.push(`  Source (lines ${sourcePreview.startLine}-${sourcePreview.endLine}):`);
    const maxLineNum = sourcePreview.endLine;
    const lineNumWidth = String(maxLineNum).length;
    for (let i = 0; i < sourcePreview.lines.length; i++) {
      const lineNum = sourcePreview.startLine + i;
      const paddedNum = String(lineNum).padStart(lineNumWidth, ' ');
      const prefix = lineNum === (node.line as number) ? '>' : ' ';
      const displayLine = sourcePreview.lines[i].length > 120
        ? sourcePreview.lines[i].slice(0, 117) + '...'
        : sourcePreview.lines[i];
      lines.push(`    ${prefix}${paddedNum} | ${displayLine}`);
    }
  }

  const formatEdgeGroup = (grouped: Record<string, ResolvedEdge[]>, dir: '->' | '<-') => {
    for (const [edgeTypeKey, edgeNodes] of Object.entries(grouped)) {
      const isStructural = CONTEXT_STRUCTURAL_EDGES.has(edgeTypeKey);
      lines.push(`    ${edgeTypeKey} (${edgeNodes.length}):`);
      for (const { node: connNode } of edgeNodes) {
        if (!connNode) {
          lines.push(`      ${dir} [dangling]`);
          continue;
        }
        const nFile = connNode.file ? (isAbsolute(connNode.file) ? relative(projectPath, connNode.file) : connNode.file) : '';
        const nLoc = nFile ? (connNode.line ? `${nFile}:${connNode.line}` : nFile) : '';
        const locStr = nLoc ? `  (${nLoc})` : '';
        lines.push(`      ${dir} [${connNode.type}] ${connNode.name || connNode.id}${locStr}`);

        // Code context for non-structural edges
        if (!isStructural && connNode.file && connNode.line && ctxLines > 0) {
          const absoluteConnFile = !isAbsolute(connNode.file) ? join(projectPath, connNode.file) : connNode.file;
          if (existsSync(absoluteConnFile)) {
            try {
              const content = readFileSync(absoluteConnFile, 'utf-8');
              const allFileLines = content.split('\n');
              const nLine = connNode.line as number;
              const sLine = Math.max(1, nLine - Math.min(ctxLines, 2));
              const eLine = Math.min(allFileLines.length, nLine + Math.min(ctxLines, 2));
              const w = String(eLine).length;
              for (let i = sLine; i <= eLine; i++) {
                const p = i === nLine ? '>' : ' ';
                const ln = String(i).padStart(w, ' ');
                const displayLn = allFileLines[i - 1].length > 120
                  ? allFileLines[i - 1].slice(0, 117) + '...'
                  : allFileLines[i - 1];
                lines.push(`           ${p}${ln} | ${displayLn}`);
              }
            } catch { /* ignore */ }
          }
        }
      }
    }
  };

  if (Object.keys(outgoingGrouped).length > 0) {
    lines.push('');
    lines.push('  Outgoing edges:');
    formatEdgeGroup(outgoingGrouped, '->');
  }

  if (Object.keys(incomingGrouped).length > 0) {
    lines.push('');
    lines.push('  Incoming edges:');
    formatEdgeGroup(incomingGrouped, '<-');
  }

  if (Object.keys(outgoingGrouped).length === 0 && Object.keys(incomingGrouped).length === 0) {
    lines.push('');
    lines.push('  No edges found.');
  }

  // Build JSON result alongside text
  const jsonResult = {
    node: { id: node.id, type: node.type, name: node.name, file: relFile, line: node.line },
    source: sourcePreview ? {
      startLine: sourcePreview.startLine,
      endLine: sourcePreview.endLine,
      lines: sourcePreview.lines,
    } : null,
    outgoing: outgoingGrouped,
    incoming: incomingGrouped,
  };

  return textResult(
    lines.join('\n') + '\n\n' + JSON.stringify(serializeBigInt(jsonResult), null, 2)
  );
}

// === BUG REPORTING ===

export async function handleReportIssue(args: ReportIssueArgs): Promise<ToolResult> {
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

// === PROJECT STRUCTURE (REG-173) ===

export async function handleReadProjectStructure(
  args: ReadProjectStructureArgs
): Promise<ToolResult> {
  const projectPath = getProjectPath();
  const subPath = args.path || '.';
  const maxDepth = Math.min(Math.max(1, args.depth || 3), 5);
  const includeFiles = args.include_files !== false;

  const targetPath = join(projectPath, subPath);

  if (!existsSync(targetPath)) {
    return errorResult(`Path does not exist: ${subPath}`);
  }

  if (!statSync(targetPath).isDirectory()) {
    return errorResult(`Path is not a directory: ${subPath}`);
  }

  const EXCLUDED = new Set([
    'node_modules', '.git', 'dist', 'build', '.grafema',
    'coverage', '.next', '.nuxt', '.cache', '.output',
    '__pycache__', '.tox', 'target',
  ]);

  const lines: string[] = [];

  function walk(dir: string, prefix: string, depth: number): void {
    if (depth > maxDepth) return;

    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const dirs: string[] = [];
    const files: string[] = [];

    for (const entry of entries) {
      if (EXCLUDED.has(entry.name)) continue;

      if (entry.isDirectory()) {
        dirs.push(entry.name);
      } else if (includeFiles) {
        files.push(entry.name);
      }
    }

    dirs.sort();
    files.sort();

    const allEntries = [
      ...dirs.map(d => ({ name: d, isDir: true })),
      ...files.map(f => ({ name: f, isDir: false })),
    ];

    for (let i = 0; i < allEntries.length; i++) {
      const entry = allEntries[i];
      const isLast = i === allEntries.length - 1;
      const connector = isLast ? '└── ' : '├── ';
      const childPrefix = isLast ? '    ' : '│   ';

      if (entry.isDir) {
        lines.push(`${prefix}${connector}${entry.name}/`);
        walk(join(dir, entry.name), prefix + childPrefix, depth + 1);
      } else {
        lines.push(`${prefix}${connector}${entry.name}`);
      }
    }
  }

  lines.push(subPath === '.' ? basename(projectPath) + '/' : subPath + '/');
  walk(targetPath, '', 1);

  if (lines.length === 1) {
    return textResult(`Directory is empty or contains only excluded entries: ${subPath}`);
  }

  return textResult(lines.join('\n'));
}

// === WRITE CONFIG (REG-173) ===

export async function handleWriteConfig(
  args: WriteConfigArgs
): Promise<ToolResult> {
  const projectPath = getProjectPath();
  const grafemaDir = join(projectPath, '.grafema');
  const configPath = join(grafemaDir, 'config.yaml');

  try {
    if (args.services) {
      validateServices(args.services, projectPath);
    }

    if (args.include !== undefined || args.exclude !== undefined) {
      const warnings: string[] = [];
      validatePatterns(args.include, args.exclude, {
        warn: (msg: string) => warnings.push(msg),
      });
    }

    if (args.workspace) {
      validateWorkspace(args.workspace, projectPath);
    }

    const config: Record<string, unknown> = {
      version: getSchemaVersion(GRAFEMA_VERSION),
    };

    if (args.services && args.services.length > 0) {
      config.services = args.services;
    }

    if (args.plugins) {
      config.plugins = args.plugins;
    }

    if (args.include) {
      config.include = args.include;
    }

    if (args.exclude) {
      config.exclude = args.exclude;
    }

    if (args.workspace) {
      config.workspace = args.workspace;
    }

    const yaml = stringifyYAML(config, { lineWidth: 0 });
    const content =
      '# Grafema Configuration\n' +
      '# Generated by Grafema onboarding\n' +
      '# Documentation: https://github.com/grafema/grafema#configuration\n\n' +
      yaml;

    if (!existsSync(grafemaDir)) {
      mkdirSync(grafemaDir, { recursive: true });
    }

    writeFileSync(configPath, content);

    const summary: string[] = ['Configuration written to .grafema/config.yaml'];

    if (args.services && args.services.length > 0) {
      summary.push(`Services: ${args.services.map(s => s.name).join(', ')}`);
    } else {
      summary.push('Services: using auto-discovery (none explicitly configured)');
    }

    if (args.plugins) {
      summary.push('Plugins: custom configuration');
    } else {
      summary.push('Plugins: using defaults');
    }

    if (args.include) {
      summary.push(`Include patterns: ${args.include.join(', ')}`);
    }

    if (args.exclude) {
      summary.push(`Exclude patterns: ${args.exclude.join(', ')}`);
    }

    if (args.workspace?.roots) {
      summary.push(`Workspace roots: ${args.workspace.roots.join(', ')}`);
    }

    summary.push('\nNext step: run analyze_project to build the graph.');

    return textResult(summary.join('\n'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResult(`Failed to write config: ${message}`);
  }
}
