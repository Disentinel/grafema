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
import { errorResult, log } from './utils.js';
import { getSocketPathOverride } from './state.js';
import {
  handleQueryGraph,
  handleFindCalls,
  handleFindNodes,
  handleTraceAlias,
  handleTraceDataflow,
  handleTraceCalls,
  handleCheckInvariant,
  handleDiscoverServices,
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
  handleGetShape,
  handleGetNode,
  handleGetNeighbors,
  handleTraverseGraph,
  // Disabled: requires git-ingest (US-17). See US-17 in AI-AGENT-STORIES.md
  // handleGitChurn,
  // handleGitCoChange,
  // handleGitOwnership,
  // handleGitArchaeology,
  handleDescribe,
  handleQueryGraphql,
  handleQueryRegistry,
  handleExplain,
  handleTraceEffects,
  handleFindSharedBehaviors,
  handleRemember,
  handleRecall,
  handleSemanticSearch,
  handleExploreEntity,
  handleAddAssertion,
  handleUpdateAssertion,
  handleDeleteAssertion,
  handleEnoxQuery,
  handleEnoxTraverse,
  handleEnoxStats,
  handleRecentActivity,
  handleUpdateNode,
  handleSaveDocument,
} from './handlers/index.js';
import type { ExplainArgs } from './handlers/index.js';
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
  TraceCallChainArgs,
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
  GetShapeArgs,
  GetNodeArgs,
  GetNeighborsArgs,
  TraverseGraphArgs,
  // Disabled: requires git-ingest (US-17). See US-17 in AI-AGENT-STORIES.md
  // GitChurnArgs,
  // GitCoChangeArgs,
  // GitOwnershipArgs,
  // GitArchaeologyArgs,
  TraceEffectsArgs,
  DescribeArgs,
  GraphQLQueryArgs,
  QueryRegistryArgs,
  FindSharedBehaviorsArgs,
} from './types.js';
import type {
  RememberArgs,
  RecallArgs,
  SemanticSearchArgs,
  ExploreEntityArgs,
  AddAssertionArgs,
  UpdateAssertionArgs,
  DeleteAssertionArgs,
  QueryGraphKnowledgeArgs,
  TraverseArgs as EnoxTraverseArgs,
  RecentActivityArgs,
  UpdateNodeArgs as EnoxUpdateNodeArgs,
  SaveDocumentArgs,
} from './handlers/enox-handlers.js';

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
const socketOverride = getSocketPathOverride();
log(`[Grafema MCP] Starting server for project: ${projectPath}${socketOverride ? ` socket=${socketOverride}` : ''}`);

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

IMPORTANT: for structural questions about code (who calls what, where is something defined,
how does data flow), avoid using Grep — it only does text matching and misses calls through
aliases, re-exports, and dynamic dispatch. Use graph tools instead.

TOOL ROUTING — use the right tool for the task:
- "Where is X defined?" → find_nodes(name="X") or find_nodes(name="X", type="CLASS")
- "Who calls function X?" → find_calls(name="X")
- "What does file X contain?" → get_file_overview(file="X")
- "How does data flow from A to B?" → trace_dataflow(source="A", direction="forward")
- "What's the structure of class X?" → describe(nodeId="X")
- "Find all classes in directory Y" → find_nodes(type="CLASS", file="Y/")
- For text search in comments or strings → Grep
- For reading exact source code → Read

EXAMPLES — how to answer common questions using graph tools:

Example 1: "Where is the drag and drop handler for the file explorer?"
  → find_nodes(name="DragAndDrop", type="CLASS")
  → Result: FileDragAndDrop in src/vs/workbench/contrib/files/browser/views/explorerViewer.ts
  → Then: get_file_overview(file="explorerViewer.ts") to see related classes

Example 2: "Who calls the createTerminal method?"
  → find_calls(name="createTerminal")
  → Result: 12 call sites across 5 files with file:line locations
  → Then: Read specific call sites for implementation details

Example 3: "What is the lifecycle of a terminal instance?"
  → find_nodes(name="Terminal", type="CLASS") to find key classes
  → find_calls(name="createTerminal") to find entry points
  → trace_dataflow(source="TerminalInstance", direction="forward") to trace the flow
  → Combine graph results with targeted Read for implementation details

find_nodes supports partial matching: find_nodes(file="auth/") matches all files in auth/.
find_nodes(name="redis", type="CALL") finds all calls containing "redis".

TIP: If unsure about the type, omit it — find_nodes(name="Foo") searches all types.
Results include _context with callers, members, and parent — often no follow-up needed.

BUG FIX PATTERN: After identifying a bug in a method, use find_calls(name="method") to check
ALL callers. Other components may call the same method without the guard your fix adds.
This catches "same bug, different caller" patterns common in large codebases.`,
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
        result = await handleTraceDataflow(asArgs<TraceDataFlowArgs>(args));
        break;

      case 'trace_calls':
        result = await handleTraceCalls(asArgs<TraceCallChainArgs>(args));
        break;

      case 'explain':
        result = await handleExplain(asArgs<ExplainArgs>(args));
        break;

      case 'trace_effects':
        result = await handleTraceEffects(asArgs<TraceEffectsArgs>(args));
        break;

      case 'check_invariant':
        result = await handleCheckInvariant(asArgs<CheckInvariantArgs>(args));
        break;

      case 'discover_services':
        result = await handleDiscoverServices();
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

      case 'get_shape':
        result = await handleGetShape(asArgs<GetShapeArgs>(args));
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

      // Disabled: requires git-ingest (US-17). See US-17 in AI-AGENT-STORIES.md
      // case 'git_churn':
      //   result = await handleGitChurn(asArgs<GitChurnArgs>(args));
      //   break;
      //
      // case 'git_cochange':
      //   result = await handleGitCoChange(asArgs<GitCoChangeArgs>(args));
      //   break;
      //
      // case 'git_ownership':
      //   result = await handleGitOwnership(asArgs<GitOwnershipArgs>(args));
      //   break;
      //
      // case 'git_archaeology':
      //   result = await handleGitArchaeology(asArgs<GitArchaeologyArgs>(args));
      //   break;

      case 'describe':
        result = await handleDescribe(asArgs<DescribeArgs>(args));
        break;

      case 'query_graphql':
        result = await handleQueryGraphql(asArgs<GraphQLQueryArgs>(args));
        break;

      case 'query_registry':
        result = await handleQueryRegistry(asArgs<QueryRegistryArgs>(args));
        break;

      case 'find_shared_behaviors':
        result = await handleFindSharedBehaviors(asArgs<FindSharedBehaviorsArgs>(args));
        break;

      // === Enox knowledge graph ===
      case 'remember':
        result = await handleRemember(asArgs<RememberArgs>(args));
        break;

      case 'recall':
        result = await handleRecall(asArgs<RecallArgs>(args));
        break;

      case 'semantic_search':
        result = await handleSemanticSearch(asArgs<SemanticSearchArgs>(args));
        break;

      case 'enox_explore':
        result = await handleExploreEntity(asArgs<ExploreEntityArgs>(args));
        break;

      case 'add_assertion':
        result = await handleAddAssertion(asArgs<AddAssertionArgs>(args));
        break;

      case 'update_assertion':
        result = await handleUpdateAssertion(asArgs<UpdateAssertionArgs>(args));
        break;

      case 'delete_assertion':
        result = await handleDeleteAssertion(asArgs<DeleteAssertionArgs>(args));
        break;

      case 'enox_query':
        result = await handleEnoxQuery(asArgs<QueryGraphKnowledgeArgs>(args));
        break;

      case 'enox_traverse':
        result = await handleEnoxTraverse(asArgs<EnoxTraverseArgs>(args));
        break;

      case 'enox_stats':
        result = await handleEnoxStats();
        break;

      case 'recent_activity':
        result = await handleRecentActivity(asArgs<RecentActivityArgs>(args));
        break;

      case 'update_node':
        result = await handleUpdateNode(asArgs<EnoxUpdateNodeArgs>(args));
        break;

      case 'save_document':
        result = await handleSaveDocument(asArgs<SaveDocumentArgs>(args));
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
