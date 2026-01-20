#!/usr/bin/env node
/**
 * Grafema MCP Server
 *
 * Provides code analysis tools via Model Context Protocol.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { TOOLS } from './definitions.js';
import { initializeFromArgs, setupLogging, getProjectPath } from './state.js';
import { textResult, errorResult, log } from './utils.js';
import { ensureAnalyzed, discoverServices } from './analysis.js';
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
  handleReportIssue,
} from './handlers.js';
import type { ToolResult, ReportIssueArgs, GetDocumentationArgs } from './types.js';

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
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async (_request, _extra) => {
  return { tools: TOOLS };
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
        result = await handleQueryGraph(args as any);
        break;

      case 'find_calls':
        result = await handleFindCalls(args as any);
        break;

      case 'find_nodes':
        result = await handleFindNodes(args as any);
        break;

      case 'trace_alias':
        result = await handleTraceAlias(args as any);
        break;

      case 'trace_dataflow':
        result = await handleTraceDataFlow(args as any);
        break;

      case 'check_invariant':
        result = await handleCheckInvariant(args as any);
        break;

      case 'discover_services':
        const services = await discoverServices();
        result = textResult(`Found ${services.length} service(s):\n${JSON.stringify(services, null, 2)}`);
        break;

      case 'analyze_project':
        result = await handleAnalyzeProject(args as any);
        break;

      case 'get_analysis_status':
        result = await handleGetAnalysisStatus();
        break;

      case 'get_stats':
        result = await handleGetStats();
        break;

      case 'get_schema':
        result = await handleGetSchema(args as any);
        break;

      case 'create_guarantee':
        result = await handleCreateGuarantee(args as any);
        break;

      case 'list_guarantees':
        result = await handleListGuarantees();
        break;

      case 'check_guarantees':
        result = await handleCheckGuarantees(args as any);
        break;

      case 'delete_guarantee':
        result = await handleDeleteGuarantee(args as any);
        break;

      case 'get_coverage':
        result = await handleGetCoverage(args as any);
        break;

      case 'get_documentation':
        result = await handleGetDocumentation(args as GetDocumentationArgs);
        break;

      case 'report_issue':
        result = await handleReportIssue(args as unknown as ReportIssueArgs);
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
    log(`[Grafema MCP] ✗ ${name} FAILED after ${duration}ms: ${(error as Error).message}`);
    return errorResult((error as Error).message);
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
