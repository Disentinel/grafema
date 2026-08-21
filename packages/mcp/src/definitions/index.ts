/**
 * MCP Tool Definitions — combined re-export
 *
 * The advertised surface is the consolidated ~27-tool set. Removed/renamed legacy
 * tool names are NOT advertised here; they remain working as hidden dispatch
 * aliases in server.ts (with arg translation + a deprecation log).
 */

export type { ToolDefinition, SchemaProperty } from './types.js';

import type { ToolDefinition } from './types.js';
import { QUERY_TOOLS } from './query-tools.js';
import { ANALYSIS_TOOLS } from './analysis-tools.js';
import { GUARANTEE_TOOLS } from './guarantee-tools.js';
import { CONTEXT_TOOLS } from './context-tools.js';
import { PROJECT_TOOLS } from './project-tools.js';
import { ENOX_TOOLS } from './enox-tools.js';
import { REGISTRY_TOOLS } from './registry-tools.js';

export const TOOLS: ToolDefinition[] = [
  ...QUERY_TOOLS,
  ...ANALYSIS_TOOLS,
  ...GUARANTEE_TOOLS,
  ...CONTEXT_TOOLS,
  ...PROJECT_TOOLS,
  ...ENOX_TOOLS,
  ...REGISTRY_TOOLS,
];
