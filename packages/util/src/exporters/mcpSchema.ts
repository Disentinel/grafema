/**
 * MCP tool registry renderer for `grafema export --as mcp-schema` (REG-1116
 * Phase 2).
 *
 * Emits the canonical MCP `tools/list` JSON document — an array of tool
 * descriptors that an MCP server can serve back to clients. Only `mcp:tool`
 * features are supported; the orchestrator validates the feature/format
 * pairing via `Renderer.supports` before calling render().
 *
 * Mapping (per `_ai/research/feature-taxonomy.md` §6):
 *   feature.name            -> tools[].name (surrounding quotes stripped)
 *   contract.outputs[0].description -> tools[].description
 *   contract.inputs[]       -> tools[].inputSchema.properties[name]
 *                              ({ type, description? })
 *   inputs[].optional===false -> tools[].inputSchema.required
 *
 * Contract preference: prefer `source === 'mcp-inputSchema'`. If multiple
 * contracts are attached, the first non-`mcp-inputSchema` one is used as a
 * fallback. Features with no contract are skipped.
 *
 * Output is JSON, pretty-printed with 2-space indent.
 */
import type { Renderer, FeatureExportSnapshot } from './types.js';
import type {
  SpecedContractData,
  SpecedContractInput,
} from '../enrichers/specedContractEnricher.js';

interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, McpPropertySchema>;
    required: string[];
  };
}

interface McpPropertySchema {
  type: string;
  description?: string;
}

export const mcpSchemaRenderer: Renderer = {
  format: 'mcp-schema',
  supports(category: string): boolean {
    return category === 'mcp:tool';
  },
  render(snapshots: FeatureExportSnapshot[]): string {
    const tools: McpToolDescriptor[] = [];
    for (const f of snapshots) {
      if (f.category !== 'mcp:tool') continue;
      const contract = pickContract(f.contracts);
      if (!contract) continue;
      tools.push(buildToolDescriptor(f, contract));
    }
    return JSON.stringify({ tools }, null, 2) + '\n';
  },
};

function pickContract(
  contracts: SpecedContractData[],
): SpecedContractData | null {
  if (contracts.length === 0) return null;
  const preferred = contracts.find((c) => c.source === 'mcp-inputSchema');
  return preferred ?? contracts[0];
}

function buildToolDescriptor(
  feature: FeatureExportSnapshot,
  contract: SpecedContractData,
): McpToolDescriptor {
  const properties: Record<string, McpPropertySchema> = {};
  const required: string[] = [];

  for (const inp of contract.inputs) {
    properties[inp.name] = buildPropertySchema(inp);
    if (inp.optional === false) required.push(inp.name);
  }

  return {
    name: stripQuotes(feature.name),
    description: contract.outputs[0]?.description ?? '',
    inputSchema: {
      type: 'object',
      properties,
      required,
    },
  };
}

function buildPropertySchema(input: SpecedContractInput): McpPropertySchema {
  // JSON Schema's canonical type names. SpecedContractInput.type is a free-form
  // hint produced by the extractor — pass it through, defaulting to 'string'
  // when missing.
  const schema: McpPropertySchema = { type: input.type ?? 'string' };
  if (input.description) schema.description = input.description;
  return schema;
}

/**
 * Feature names sometimes carry surrounding quotes from the literal in the
 * source ("'analyze'" or '"analyze"'). MCP tool names must be bare strings,
 * so strip a single matching pair if present.
 */
function stripQuotes(name: string): string {
  if (name.length < 2) return name;
  const first = name.charAt(0);
  const last = name.charAt(name.length - 1);
  if ((first === "'" || first === '"') && first === last) {
    return name.slice(1, -1);
  }
  return name;
}
