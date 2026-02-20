/**
 * MCP Tool Definitions — combined re-export
 */

export type { ToolDefinition, SchemaProperty } from './types.js';

import type { ToolDefinition } from './types.js';
import { QUERY_TOOLS } from './query-tools.js';
import { ANALYSIS_TOOLS } from './analysis-tools.js';
import { GUARANTEE_TOOLS } from './guarantee-tools.js';
import { CONTEXT_TOOLS } from './context-tools.js';
import { PROJECT_TOOLS } from './project-tools.js';
import { GRAPH_TOOLS } from './graph-tools.js';

export const TOOLS: ToolDefinition[] = [
  ...QUERY_TOOLS,
  ...ANALYSIS_TOOLS,
  ...GUARANTEE_TOOLS,
  ...CONTEXT_TOOLS,
  ...PROJECT_TOOLS,
  ...GRAPH_TOOLS,
];
