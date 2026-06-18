/**
 * Analysis Tools — project analysis and schema inspection
 */

import type { ToolDefinition } from './types.js';

export const ANALYSIS_TOOLS: ToolDefinition[] = [
  {
    name: 'discover_services',
    description: `Discover services in the project without running full analysis.

Use this during onboarding to understand project structure BEFORE running analyze_project.

Returns:
- Service names and paths (e.g., "backend" at "apps/backend")
- Entry points (e.g., "src/index.ts")
- No graph data yet — this is fast discovery only

Workflow:
1. discover_services — see what's in the project
2. analyze_project — build graph for specific service or all
3. Query tools — explore the graph

Tip: If project has no .grafema/config.yaml, this scans for common patterns
(package.json, index.ts, etc.). Use write_config to save the configuration.`,
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'analyze_project',
    description: `Build the code graph by analyzing project source code.

REQUIRED before using query tools. Without analysis, the graph is empty.

Options:
- service: Analyze only one service (faster for multi-service projects)
- force: Re-analyze even if graph exists (use after code changes)
- index_only: Fast mode — create MODULE nodes only, skip detailed analysis

Phases: Discovery → Indexing → Analysis → Enrichment → Validation
Returns: Analysis summary with node/edge counts and timing.

Tip: Use get_stats after analysis to verify graph was built successfully.`,
    inputSchema: {
      type: 'object',
      properties: {
        service: {
          type: 'string',
          description: 'Optional: analyze only this service',
        },
        force: {
          type: 'boolean',
          description: 'Force re-analysis even if already analyzed',
        },
        index_only: {
          type: 'boolean',
          description: 'Only index modules, skip full analysis',
        },
      },
    },
  },
  {
    name: 'get_analysis_status',
    description: `Get the current analysis status and progress.

Use this to:
- Poll progress during long-running analysis (started by analyze_project)
- Check if analysis is still running before making queries
- See which phase is active (discovery, indexing, analysis, enrichment, validation)

Returns: { running: boolean, phase: string, progress: number, error: string | null }

Call this periodically after analyze_project to monitor progress.`,
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_stats',
    description: `Get graph statistics and/or schema — counts and the available node/edge type vocabulary.

Use this to:
- Verify analysis completed: nodeCount > 0 means the graph is loaded (call BEFORE querying).
- Understand graph size before running expensive queries.
- Discover the type vocabulary before writing Datalog/Cypher (e.g. "http:route" not "HTTP_ROUTE").
- Debug empty results: check if expected node/edge types are present.

Set \`include\` (array, default both):
- "counts" — nodeCount, edgeCount, nodesByType, edgesByType, shard diagnostics.
- "schema" — the node and edge type names with counts (the query vocabulary).

Set \`graph\` to "knowledge" for the project knowledge graph instead of the code graph
(default "code").`,
    inputSchema: {
      type: 'object',
      properties: {
        graph: {
          type: 'string',
          description: 'Which graph: "code" (default) or "knowledge".',
          enum: ['code', 'knowledge'],
        },
        include: {
          type: 'array',
          items: { type: 'string', enum: ['counts', 'schema'] },
          description: 'What to include: "counts" and/or "schema" (default: both).',
        },
      },
    },
  },
];
