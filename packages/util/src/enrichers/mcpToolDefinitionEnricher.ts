/**
 * mcpToolDefinitionEnricher — extract MCP tool definitions from
 * `packages/mcp/src/definitions/*-tools.ts` (or any directory containing
 * such files) and create `mcp:tool` graph nodes for each.
 *
 * Why this enricher exists:
 *   The complementary `libraryCallbackEnricher` finds the four high-level
 *   `setRequestHandler` calls in the MCP server entry point. The actual ~30+
 *   tools are dispatched via a switch statement on `request.params.name`,
 *   which the call-graph cannot represent as separate domain nodes. The
 *   tool _definitions_ are however statically declared in dedicated files.
 *
 * Strategy:
 *   The graph does not preserve object-literal property structure (no
 *   PROPERTY/EXPRESSION nodes connecting object keys to values), so we
 *   cannot reliably identify "this string literal is the value of a `name:`
 *   key in a tool definition object" from the graph alone. We therefore
 *   parse the definition files as text. The pattern is extremely regular
 *   (each file exports a single `ToolDefinition[]` array with one element
 *   per tool, top-level fields at exactly 4-space indentation), so a small
 *   line-based scanner is robust without dragging in @babel/parser.
 *
 * Handler resolution:
 *   For each tool, we compute the conventional handler name (`get_node` →
 *   `handleGetNode`) and look up a FUNCTION node by that name in the graph.
 *   When found, we emit a HANDLES edge from the mcp:tool to the handler.
 *   When not found, the tool name is recorded in `unresolvedHandlers` for
 *   diagnostics.
 *
 * Like libraryCallbackEnricher, we use direct addNodes/addEdges rather than
 * createBatch().commit() to avoid wiping pre-existing nodes in the same
 * files (BatchHandle commits go through commitBatch which deletes nodes
 * whose `file` field is in the changed-files list).
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { RFDBClient } from '@grafema/rfdb-client';
import type { WireNode, WireEdge } from '@grafema/types';

export interface McpToolEnrichResult {
  /** Number of `mcp:tool` nodes created. */
  toolNodesCreated: number;
  /** Number of HANDLES edges emitted (mcp:tool → handler FUNCTION). */
  handlesEdgesCreated: number;
  /** Tool names whose conventional handler could not be located in the graph. */
  unresolvedHandlers: string[];
}

export interface McpToolEnrichOptions {
  /** Directory containing `*-tools.ts` definition files. */
  definitionsDir?: string;
  /** Prefix prepended to PascalCase(toolName) when looking up handlers. */
  handlerPrefix?: string;
}

const DEFAULT_DEFINITIONS_DIR = 'packages/mcp/src/definitions';
const DEFAULT_HANDLER_PREFIX = 'handle';

/** Public entry point. */
export async function enrichMcpToolDefinitions(
  client: RFDBClient,
  options: McpToolEnrichOptions = {},
): Promise<McpToolEnrichResult> {
  const result: McpToolEnrichResult = {
    toolNodesCreated: 0,
    handlesEdgesCreated: 0,
    unresolvedHandlers: [],
  };

  const definitionsDir = options.definitionsDir ?? DEFAULT_DEFINITIONS_DIR;
  const handlerPrefix = options.handlerPrefix ?? DEFAULT_HANDLER_PREFIX;

  if (!existsSync(definitionsDir)) return result;

  const tools = collectToolsFromDir(definitionsDir);
  if (tools.length === 0) return result;

  const newNodes: WireNode[] = [];
  const newEdges: WireEdge[] = [];
  const seenIds = new Set<string>();

  for (const tool of tools) {
    const handlerName = handlerPrefix + pascalCase(tool.name);
    const handlerId = await findHandlerFunctionId(client, handlerName);

    const toolNodeId = makeToolNodeId(tool.file, tool.name);
    if (seenIds.has(toolNodeId)) continue;
    seenIds.add(toolNodeId);

    const metadata: Record<string, unknown> = {
      definition_file: tool.file,
    };
    if (tool.description) metadata.description = tool.description;
    if (handlerId) metadata.handler_function_id = handlerId;

    newNodes.push({
      id: toolNodeId,
      nodeType: 'mcp:tool' as never,
      name: tool.name,
      file: tool.file,
      exported: false,
      metadata: JSON.stringify(metadata),
    });
    result.toolNodesCreated++;

    if (handlerId) {
      newEdges.push({
        src: toolNodeId,
        dst: handlerId,
        edgeType: 'HANDLES' as never,
        metadata: JSON.stringify({}),
      });
      result.handlesEdgesCreated++;
    } else {
      result.unresolvedHandlers.push(tool.name);
    }
  }

  if (newNodes.length > 0) await client.addNodes(newNodes);
  if (newEdges.length > 0) await client.addEdges(newEdges);

  return result;
}

/** ---------------------------------------------------------------------------
 *  Scanning definition files
 *  ------------------------------------------------------------------------ */

interface ToolDef {
  name: string;
  description: string | null;
  file: string;
}

function collectToolsFromDir(dir: string): ToolDef[] {
  const out: ToolDef[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    // Convention: only files matching *-tools.ts contain ToolDefinition[].
    // Skip types.ts, index.ts, and any non-tool sources.
    if (!entry.endsWith('-tools.ts')) continue;
    const filePath = join(dir, entry);
    let source: string;
    try {
      source = readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }
    for (const tool of parseToolDefinitions(source)) {
      out.push({ ...tool, file: filePath });
    }
  }
  return out;
}

/**
 * Parse a `*-tools.ts` file and yield each top-level tool entry.
 *
 * The convention enforced by the MCP definitions package is:
 *   export const X_TOOLS: ToolDefinition[] = [
 *     {
 *       name: 'tool_name',
 *       description: '...' | `...`,
 *       inputSchema: { ... },
 *     },
 *     ...
 *   ];
 *
 * Top-level keys appear at exactly 4-space indentation, while nested
 * inputSchema property keys are at 10+ spaces. We rely on this regularity
 * rather than parsing the AST — the cost of pulling in @babel/parser is not
 * justified for ~10 files of strictly-regular shape.
 */
export function parseToolDefinitions(source: string): Array<{ name: string; description: string | null }> {
  const tools: Array<{ name: string; description: string | null }> = [];
  // Match exactly 4-space indented `name: '...'` (the top-level tool field).
  // Captures the tool name without surrounding quotes.
  const NAME_RE = /^ {4}name: ['"`]([^'"`]+)['"`],?\s*$/gm;

  let m: RegExpExecArray | null;
  while ((m = NAME_RE.exec(source)) !== null) {
    const name = m[1];
    if (!isValidToolName(name)) continue;
    const description = extractDescriptionAfter(source, m.index + m[0].length);
    tools.push({ name, description });
  }
  return tools;
}

function isValidToolName(s: string): boolean {
  // Tool names are JS-identifier-ish snake_case strings.
  return /^[a-z][a-z0-9_]*$/.test(s);
}

/** Extract the `description: ...` value that immediately follows a tool's name field.
 *  Supports single-quoted, double-quoted, and template-literal strings. Returns
 *  null if no description is found within a small lookahead window. */
function extractDescriptionAfter(source: string, fromIdx: number): string | null {
  // Description must appear at exactly 4-space indent immediately after the
  // name line. We scan up to ~200 lines to allow for multi-line descriptions
  // that follow.
  const slice = source.substring(fromIdx, fromIdx + 8000);
  const match = /^ {4}description: (['"`])/m.exec(slice);
  if (!match) return null;
  const quote = match[1];
  const startIdx = match.index + match[0].length;
  const endIdx = findUnescapedQuote(slice, startIdx, quote);
  if (endIdx < 0) return null;
  // Limit to a reasonable size so metadata doesn't blow up.
  const raw = slice.substring(startIdx, endIdx);
  return raw.length > 4000 ? raw.substring(0, 4000) : raw;
}

function findUnescapedQuote(s: string, start: number, quote: string): number {
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\') { i++; continue; }
    if (ch === quote) return i;
  }
  return -1;
}

/** ---------------------------------------------------------------------------
 *  Handler lookup
 *  ------------------------------------------------------------------------ */

async function findHandlerFunctionId(client: RFDBClient, handlerName: string): Promise<string | null> {
  // Look for a FUNCTION node by exact name. Multiple matches are unlikely,
  // but we accept the first (handler files are conventionally in
  // packages/mcp/src/handlers/).
  for await (const wn of client.queryNodes({ type: 'FUNCTION', name: handlerName })) {
    if (wn.name === handlerName) return wn.id;
  }
  return null;
}

/** ---------------------------------------------------------------------------
 *  Helpers
 *  ------------------------------------------------------------------------ */

export function pascalCase(snake: string): string {
  return snake
    .split('_')
    .filter(seg => seg.length > 0)
    .map(seg => seg.charAt(0).toUpperCase() + seg.slice(1))
    .join('');
}

function makeToolNodeId(file: string, toolName: string): string {
  // Deterministic ID: stable across runs given the same definitions file
  // and tool name. The `definition` discriminator distinguishes these from
  // anchor-call-based mcp:tool nodes produced by libraryCallbackEnricher
  // (which use `<file>::mcp:tool::<name>::<callId>`).
  return `${file}::mcp:tool::definition::${toolName}`;
}
