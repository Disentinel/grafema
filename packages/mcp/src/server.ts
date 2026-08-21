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
  handleFindCalls,
  handleDiscoverServices,
  handleAnalyzeProject,
  handleGetAnalysisStatus,
  handleCreateGuarantee,
  handleListGuarantees,
  handleCheckGuarantees,
  handleDeleteGuarantee,
  handleGetCoverage,
  handleGetDocumentation,
  handleFindGuards,
  handleReportIssue,
  handleReadProjectStructure,
  handleWriteConfig,
  handleGetFileOverview,
  handleGetShape,
  // Disabled: requires git-ingest (US-17). See US-17 in AI-AGENT-STORIES.md
  // handleGitChurn,
  // handleGitCoChange,
  // handleGitOwnership,
  // handleGitArchaeology,
  handleDescribe,
  handleQueryGraphql,
  handleQueryRegistry,
  handleExplain,
  handleFindSharedBehaviors,
  handleRecall,
  handleExploreEntity,
  handleUpdateAssertion,
  handleAssert,
  handleRetract,
  handleEnoxQuery,
  handleEnoxTraverse,
  handleEnoxStats,
  handleRecentActivity,
  handleUpdateNode,
  handleCrawlEntity,
  handleSaveDocument,
  // Consolidated routers (advertised tool surface)
  handleQueryGraphRouted,
  handleFindNodesRouted,
  handleGetStatsRouted,
  handleTrace,
  handleExplainDatalog,
  handleGetNodeRouted,
} from './handlers/index.js';
import type { ExplainArgs } from './handlers/index.js';
import type {
  AssertArgs,
  RetractArgs,
  GetStatsRoutedArgs,
  TraceRoutedArgs,
  ExplainDatalogArgs,
  GetNodeRoutedArgs,
} from './handlers/index.js';
import type {
  ToolResult,
  ReportIssueArgs,
  GetDocumentationArgs,
  QueryGraphArgs,
  FindCallsArgs,
  FindNodesArgs,
  CheckInvariantArgs,
  AnalyzeProjectArgs,
  CreateGuaranteeArgs,
  CheckGuaranteesArgs,
  DeleteGuaranteeArgs,
  GetCoverageArgs,
  FindGuardsArgs,
  ReadProjectStructureArgs,
  WriteConfigArgs,
  GetFileOverviewArgs,
  GetShapeArgs,
  // Disabled: requires git-ingest (US-17). See US-17 in AI-AGENT-STORIES.md
  // GitChurnArgs,
  // GitCoChangeArgs,
  // GitOwnershipArgs,
  // GitArchaeologyArgs,
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
  CrawlEntityArgs,
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

  // Deprecation note for hidden legacy aliases (not advertised in tools/list).
  const deprecated = (newName: string) =>
    log(`[Grafema MCP] ⚠ deprecated tool "${name}" → use "${newName}". This alias still works but is hidden from tools/list.`);

  try {
    let result: ToolResult;

    switch (name) {
      // =====================================================================
      // ADVERTISED TOOLS (the consolidated ~27-tool surface)
      // =====================================================================

      // --- code/graph ---
      case 'query_graph':
        result = await handleQueryGraphRouted(asArgs<QueryGraphArgs & Record<string, unknown>>(args));
        break;

      case 'find_nodes':
        result = await handleFindNodesRouted(asArgs<FindNodesArgs & Record<string, unknown>>(args));
        break;

      case 'find_calls':
        result = await handleFindCalls(asArgs<FindCallsArgs>(args));
        break;

      case 'get_node':
        result = await handleGetNodeRouted(asArgs<GetNodeRoutedArgs>(args));
        break;

      case 'trace':
        result = await handleTrace(asArgs<TraceRoutedArgs>(args));
        break;

      case 'explain_datalog':
        result = await handleExplainDatalog(asArgs<ExplainDatalogArgs>(args));
        break;

      case 'get_stats':
        result = await handleGetStatsRouted(asArgs<GetStatsRoutedArgs>(args));
        break;

      case 'find_guards':
        result = await handleFindGuards(asArgs<FindGuardsArgs>(args));
        break;

      case 'find_shared_behaviors':
        result = await handleFindSharedBehaviors(asArgs<FindSharedBehaviorsArgs>(args));
        break;

      // --- knowledge ---
      case 'assert':
        result = await handleAssert(asArgs<AssertArgs>(args));
        break;

      case 'retract':
        result = await handleRetract(asArgs<RetractArgs>(args));
        break;

      case 'recall':
        result = await handleRecall(asArgs<RecallArgs>(args));
        break;

      case 'crawl_entity':
        result = await handleCrawlEntity(asArgs<CrawlEntityArgs>(args));
        break;

      case 'save_document':
        result = await handleSaveDocument(asArgs<SaveDocumentArgs>(args));
        break;

      // --- project lifecycle ---
      case 'analyze_project':
        result = await handleAnalyzeProject(asArgs<AnalyzeProjectArgs>(args));
        break;

      case 'discover_services':
        result = await handleDiscoverServices();
        break;

      case 'get_analysis_status':
        result = await handleGetAnalysisStatus();
        break;

      case 'get_coverage':
        result = await handleGetCoverage(asArgs<GetCoverageArgs>(args));
        break;

      case 'write_config':
        result = await handleWriteConfig(asArgs<WriteConfigArgs>(args));
        break;

      case 'read_project_structure':
        result = await handleReadProjectStructure(asArgs<ReadProjectStructureArgs>(args));
        break;

      // --- docs / issue / guarantees / registry ---
      case 'get_docs':
        result = await handleGetDocumentation(asArgs<GetDocumentationArgs>(args));
        break;

      case 'report_issue':
        result = await handleReportIssue(asArgs<ReportIssueArgs>(args));
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

      case 'query_registry':
        result = await handleQueryRegistry(asArgs<QueryRegistryArgs>(args));
        break;

      // =====================================================================
      // HIDDEN LEGACY ALIASES — NOT advertised in tools/list. Each maps to the
      // consolidated handler with arg translation + a deprecation log.
      // =====================================================================

      // get_node family
      case 'get_neighbors':
        deprecated('get_node (detail="neighbors")');
        result = await handleGetNodeRouted({ ...asArgs<Record<string, unknown>>(args), detail: 'neighbors' });
        break;

      case 'get_context':
        deprecated('get_node (detail="context")');
        result = await handleGetNodeRouted({ ...asArgs<Record<string, unknown>>(args), detail: 'context' });
        break;

      case 'get_function_details':
        deprecated('get_node (detail="full")');
        result = await handleGetNodeRouted({ ...asArgs<Record<string, unknown>>(args), detail: 'full' });
        break;

      case 'get_file_overview':
        deprecated('get_node (target=<file>)');
        result = await handleGetFileOverview(asArgs<GetFileOverviewArgs>(args));
        break;

      case 'get_shape':
        deprecated('get_node (on a CLASS/INTERFACE)');
        result = await handleGetShape(asArgs<GetShapeArgs>(args));
        break;

      case 'describe':
        deprecated('get_node (format="dsl")');
        result = await handleDescribe(asArgs<DescribeArgs>(args));
        break;

      // trace family
      case 'trace_dataflow':
        deprecated('trace (along="data")');
        result = await handleTrace({ ...asArgs<Record<string, unknown>>(args), source: String((args as Record<string, unknown>)?.source ?? ''), along: 'data' });
        break;

      case 'trace_calls':
        deprecated('trace (along="calls")');
        result = await handleTrace({ ...asArgs<Record<string, unknown>>(args), source: String((args as Record<string, unknown>)?.source ?? ''), along: 'calls' });
        break;

      case 'trace_effects': {
        deprecated('trace (along="effects")');
        const a = asArgs<Record<string, unknown>>(args);
        result = await handleTrace({ ...a, source: String(a.node ?? a.source ?? ''), along: 'effects' });
        break;
      }

      case 'trace_alias': {
        deprecated('trace (along="alias")');
        const a = asArgs<Record<string, unknown>>(args);
        result = await handleTrace({ ...a, source: String(a.variableName ?? a.source ?? ''), file: a.file as string | undefined, along: 'alias' });
        break;
      }

      case 'traverse_graph': {
        deprecated('trace (along="edges")');
        const a = asArgs<Record<string, unknown>>(args);
        const startIds = (a.startNodeIds as string[] | undefined) ?? [];
        result = await handleTrace({
          source: startIds[0] ?? String(a.source ?? ''),
          along: 'edges',
          edge_types: a.edgeTypes as string[] | undefined,
          maxDepth: a.maxDepth as number | undefined,
          direction: (a.direction as 'forward' | 'backward' | 'both' | undefined),
        });
        break;
      }

      // explain_datalog family
      case 'explain_fact':
        deprecated('explain_datalog (mode="fact")');
        result = await handleExplainDatalog({ ...asArgs<Record<string, unknown>>(args), mode: 'fact' } as ExplainDatalogArgs);
        break;

      case 'explain_gap':
        deprecated('explain_datalog (mode="gap")');
        result = await handleExplainDatalog({ ...asArgs<Record<string, unknown>>(args), mode: 'gap' } as ExplainDatalogArgs);
        break;

      case 'sim_datalog':
        deprecated('explain_datalog (mode="sim")');
        result = await handleExplainDatalog({ ...asArgs<Record<string, unknown>>(args), mode: 'sim' } as ExplainDatalogArgs);
        break;

      // query family
      case 'query_graphql':
        deprecated('query_graph (language="graphql")');
        result = await handleQueryGraphql(asArgs<GraphQLQueryArgs>(args));
        break;

      case 'check_invariant': {
        deprecated('query_graph (datalog violation rule)');
        // check_invariant ran a violation rule; route to query_graph with the rule as query.
        const a = asArgs<CheckInvariantArgs>(args);
        result = await handleQueryGraphRouted({ ...a, query: a.rule } as QueryGraphArgs & Record<string, unknown>);
        break;
      }

      // get_stats / get_schema family
      case 'get_schema': {
        deprecated('get_stats (include=["schema"])');
        result = await handleGetStatsRouted({ include: ['schema'] });
        break;
      }

      // explain (dropped — returns an LLM prompt, not data) kept as alias
      case 'explain':
        deprecated('get_node / trace (explain returns an LLM prompt, not data)');
        result = await handleExplain(asArgs<ExplainArgs>(args));
        break;

      // documentation rename
      case 'get_documentation':
        deprecated('get_docs');
        result = await handleGetDocumentation(asArgs<GetDocumentationArgs>(args));
        break;

      // knowledge: assert family
      case 'remember': {
        deprecated('assert (single-element assertions array)');
        const a = asArgs<RememberArgs>(args);
        // remember(subject, fact) → assert one fact: subject -[relation]-> fact text.
        result = await handleAssert({
          assertions: [{
            from: a.subject,
            relation: a.relation ?? 'about',
            to: a.fact,
            context: a.fact,
            confidence: a.confidence,
            domain: a.domain,
          }],
        });
        break;
      }

      case 'add_assertion': {
        deprecated('assert (single-element assertions array)');
        const a = asArgs<AddAssertionArgs>(args);
        result = await handleAssert({ assertions: [a] });
        break;
      }

      case 'update_assertion': {
        deprecated('assert (re-assert to upsert) / retract');
        // Keep the existing fact_id-based update working.
        result = await handleUpdateAssertion(asArgs<UpdateAssertionArgs>(args));
        break;
      }

      case 'supersede':
      case 'supersede_fact': {
        deprecated('assert (relation="supersedes")');
        const a = asArgs<Record<string, unknown>>(args);
        result = await handleAssert({
          assertions: [{
            from: String(a.from ?? a.new_content ?? a.new ?? ''),
            relation: 'supersedes',
            to: String(a.to ?? a.old_id ?? a.old ?? ''),
            context: a.context as string | undefined,
            confidence: a.confidence as number | undefined,
            domain: a.domain as string | undefined,
          }],
        });
        break;
      }

      // knowledge: retract family
      case 'delete_assertion': {
        deprecated('retract (fact_ids array)');
        const a = asArgs<DeleteAssertionArgs>(args);
        result = await handleRetract({ fact_ids: [a.fact_id] });
        break;
      }

      // knowledge: recall family
      case 'semantic_search': {
        deprecated('recall');
        const a = asArgs<SemanticSearchArgs>(args);
        result = await handleRecall({ query: a.query, top_k: a.top_k, domain: a.domain });
        break;
      }

      // knowledge: read aliases routed to graph="knowledge" verbs
      case 'enox_explore': {
        deprecated('get_node (graph="knowledge")');
        const a = asArgs<ExploreEntityArgs>(args);
        result = await handleExploreEntity(a);
        break;
      }

      case 'enox_query': {
        deprecated('find_nodes (graph="knowledge")');
        result = await handleEnoxQuery(asArgs<QueryGraphKnowledgeArgs>(args));
        break;
      }

      case 'enox_traverse': {
        deprecated('trace (graph="knowledge", along="edges")');
        result = await handleEnoxTraverse(asArgs<EnoxTraverseArgs>(args));
        break;
      }

      case 'enox_stats': {
        deprecated('get_stats (graph="knowledge")');
        result = await handleEnoxStats();
        break;
      }

      // knowledge: dropped standalones still reachable as aliases
      case 'recent_activity':
        deprecated('query_graph/find_nodes (graph="knowledge")');
        result = await handleRecentActivity(asArgs<RecentActivityArgs>(args));
        break;

      case 'update_node':
        deprecated('get_node + assert (graph="knowledge")');
        result = await handleUpdateNode(asArgs<EnoxUpdateNodeArgs>(args));
        break;

      // Disabled: requires git-ingest (US-17). See US-17 in AI-AGENT-STORIES.md
      // case 'git_churn': …

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
