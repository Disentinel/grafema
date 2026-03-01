#!/usr/bin/env node
/**
 * Grafema MCP Server
 *
 * Graph-driven code analysis for AI agents. Query the code graph instead of reading files.
 *
 * Use Grafema when you need to:
 * - Navigate code structure (find callers, trace data flow, understand impact)
 * - Answer "who calls this?", "where is this used?", "what does this affect?"
 * - Analyze untyped/dynamic codebases where static analysis falls short
 * - Track relationships across files without manual grep
 *
 * Core capabilities:
 * - Datalog queries for pattern matching (query_graph)
 * - Call graph navigation (find_calls, get_function_details)
 * - Data flow tracing (trace_dataflow, trace_alias)
 * - Graph traversal primitives (get_node, get_neighbors, traverse_graph)
 * - Code guarantees/invariants (create_guarantee, check_guarantees)
 *
 * Workflow:
 * 1. discover_services — identify project structure
 * 2. analyze_project — build the graph
 * 3. Use query tools to explore code relationships
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { PROMPTS, getPrompt } from './prompts.js';

import { TOOLS } from './definitions/index.js';
import { initializeFromArgs, setupLogging, getProjectPath } from './state.js';
import { textResult, errorResult, log } from './utils.js';
import { discoverServices } from './analysis.js';
import {
  handleQueryGraph,
  handleFindCalls,
  handleFindNodes,
  handleTraceAlias,
  handleTraceDataFlow,
  handleCheckInvariant,
  handleAnalyzeProject,
  handleGetAnalysisStatus,
  handleGetStats,
  handleGetSchema,
  handleCreateGuarantee,
  handleListGuarantees,
  handleCheckGuarantees,
  handleDeleteGuarantee,
  handleGetCoverage,
  handleGetDocumentation,
  handleFindGuards,
  handleReportIssue,
  handleGetFunctionDetails,
  handleGetContext,
  handleReadProjectStructure,
  handleWriteConfig,
  handleGetFileOverview,
  handleGetNode,
  handleGetNeighbors,
  handleTraverseGraph,
} from './handlers/index.js';
import type {
  ToolResult,
  ReportIssueArgs,
  GetDocumentationArgs,
  GetFunctionDetailsArgs,
  GetContextArgs,
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
  FindGuardsArgs,
  ReadProjectStructureArgs,
  WriteConfigArgs,
  GetFileOverviewArgs,
  GetNodeArgs,
  GetNeighborsArgs,
  TraverseGraphArgs,
} from './types.js';

/**
 * Type-safe argument casting helper.
 * MCP SDK provides args as Record<string, unknown>, this helper
 * casts them to the expected handler argument type.
 */
function asArgs<T>(args: Record<string, unknown> | undefined): T {
  return (args ?? {}) as T;
}

// Initialize from command line args
initializeFromArgs();
setupLogging();

const projectPath = getProjectPath();
log(`[Grafema MCP] Starting server for project: ${projectPath}`);

// Create MCP server
const server = new Server(
  {
    name: 'grafema-mcp',
    version: '0.1.0',
    description: 'Graph-driven code analysis. Query the code graph instead of reading files. Navigate call graphs, trace data flow, verify guarantees. For AI agents working with untyped/dynamic codebases.',
  },
  {
    capabilities: {
      tools: {},
      prompts: {},
    },
    instructions: `Grafema is a code graph — use it instead of reading files.

START HERE: call get_stats to check if the graph is loaded (nodeCount > 0).
If nodeCount is 0, call analyze_project first.

EXPLORATION WORKFLOW:
1. To understand a file → get_file_overview (shows imports, exports, functions, classes with relationships)
2. To find functions/classes/modules → find_nodes (filter by type, name, or file pattern)
3. To find who calls a function → find_calls (returns call sites with resolution status)
4. To understand data flow → trace_dataflow (forward: where does this value go? backward: where does it come from?)
5. To understand full context of a node → get_context (shows surrounding code, scope chain, relationships)
6. For complex pattern queries → query_graph with Datalog (call get_documentation topic="queries" for syntax)

KEY INSIGHT: find_nodes supports partial matching on name and file fields.
Example: find_nodes(file="auth/") returns all nodes in files matching "auth/".
Example: find_nodes(name="redis", type="CALL") finds all calls containing "redis".`,
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async (_request, _extra) => {
  return { tools: TOOLS };
});

// List available prompts
server.setRequestHandler(ListPromptsRequestSchema, async () => {
  return { prompts: PROMPTS };
});

// Get prompt by name
server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  return getPrompt(request.params.name);
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  void extra; // suppress unused warning
  const { name, arguments: args } = request.params;

  const startTime = Date.now();
  const argsPreview = args ? JSON.stringify(args).slice(0, 200) : '{}';
  log(`[Grafema MCP] ▶ ${name} args=${argsPreview}`);

  try {
    let result: ToolResult;

    switch (name) {
      case 'query_graph':
        result = await handleQueryGraph(asArgs<QueryGraphArgs>(args));
        break;

      case 'find_calls':
        result = await handleFindCalls(asArgs<FindCallsArgs>(args));
        break;

      case 'find_nodes':
        result = await handleFindNodes(asArgs<FindNodesArgs>(args));
        break;

      case 'trace_alias':
        result = await handleTraceAlias(asArgs<TraceAliasArgs>(args));
        break;

      case 'trace_dataflow':
        result = await handleTraceDataFlow(asArgs<TraceDataFlowArgs>(args));
        break;

      case 'check_invariant':
        result = await handleCheckInvariant(asArgs<CheckInvariantArgs>(args));
        break;

      case 'discover_services':
        const services = await discoverServices();
        result = textResult(`Found ${services.length} service(s):\n${JSON.stringify(services, null, 2)}`);
        break;

      case 'analyze_project':
        result = await handleAnalyzeProject(asArgs<AnalyzeProjectArgs>(args));
        break;

      case 'get_analysis_status':
        result = await handleGetAnalysisStatus();
        break;

      case 'get_stats':
        result = await handleGetStats();
        break;

      case 'get_schema':
        result = await handleGetSchema(asArgs<GetSchemaArgs>(args));
        break;

      case 'create_guarantee':
        result = await handleCreateGuarantee(asArgs<CreateGuaranteeArgs>(args));
        break;

      case 'list_guarantees':
        result = await handleListGuarantees();
        break;

      case 'check_guarantees':
        result = await handleCheckGuarantees(asArgs<CheckGuaranteesArgs>(args));
        break;

      case 'delete_guarantee':
        result = await handleDeleteGuarantee(asArgs<DeleteGuaranteeArgs>(args));
        break;

      case 'get_coverage':
        result = await handleGetCoverage(asArgs<GetCoverageArgs>(args));
        break;

      case 'get_documentation':
        result = await handleGetDocumentation(asArgs<GetDocumentationArgs>(args));
        break;

      case 'find_guards':
        result = await handleFindGuards(asArgs<FindGuardsArgs>(args));
        break;

      case 'report_issue':
        result = await handleReportIssue(asArgs<ReportIssueArgs>(args));
        break;

      case 'get_function_details':
        result = await handleGetFunctionDetails(asArgs<GetFunctionDetailsArgs>(args));
        break;

      case 'get_context':
        result = await handleGetContext(asArgs<GetContextArgs>(args));
        break;

      case 'get_file_overview':
        result = await handleGetFileOverview(asArgs<GetFileOverviewArgs>(args));
        break;

      case 'read_project_structure':
        result = await handleReadProjectStructure(asArgs<ReadProjectStructureArgs>(args));
        break;

      case 'write_config':
        result = await handleWriteConfig(asArgs<WriteConfigArgs>(args));
        break;

      case 'get_node':
        result = await handleGetNode(asArgs<GetNodeArgs>(args));
        break;

      case 'get_neighbors':
        result = await handleGetNeighbors(asArgs<GetNeighborsArgs>(args));
        break;

      case 'traverse_graph':
        result = await handleTraverseGraph(asArgs<TraverseGraphArgs>(args));
        break;

      default:
        result = errorResult(`Unknown tool: ${name}`);
    }

    const duration = Date.now() - startTime;
    const resultSize = JSON.stringify(result).length;
    const status = result.isError ? '✗' : '✓';
    log(`[Grafema MCP] ${status} ${name} completed in ${duration}ms (${resultSize} bytes)`);

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;
    const message = error instanceof Error ? error.message : String(error);
    log(`[Grafema MCP] ✗ ${name} FAILED after ${duration}ms: ${message}`);
    return errorResult(message);
  }
});

// Main entry point
async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('[Grafema MCP] Server connected via stdio');
}

main().catch((error) => {
  log(`[Grafema MCP] Fatal error: ${error.message}`);
  process.exit(1);
});
