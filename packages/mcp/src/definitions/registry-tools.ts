/**
 * MCP Tool Definitions — Registry tools
 */

import type { ToolDefinition } from './types.js';

export const REGISTRY_TOOLS: ToolDefinition[] = [
  {
    name: 'query_registry',
    description: `Query the local manifest registry for package export information and side effects.

The registry contains pre-analyzed manifests for npm dependencies. Each manifest describes
a package's API surface: exported symbols, their kinds, and side effects.

Use this when you need to:
- Know what a package exports: query_registry(package="graphql") → 216 exports
- Check effects of a specific function: query_registry(package="yaml", symbol="parse") → PURE
- Understand a dependency's API without reading its source code
- Verify if a package is in the registry: query_registry(package="express") → not found

Returns: package metadata (purl, source_type, confidence), and either:
- A specific export (when symbol is given)
- All exports summary (when only package is given)
- Full registry index (when neither is given)

source_type values:
- "compiled_js" — standard npm package, fully analyzed
- "source" — TypeScript source, fully analyzed
- "minified" — bundled output (esbuild/webpack), exports not statically resolvable
- "dts_only" — type declarations only, not in registry`,
    inputSchema: {
      type: 'object',
      properties: {
        package: {
          type: 'string',
          description: 'Package name (e.g., "graphql", "@anthropic-ai/sdk"). Omit to list all packages.',
        },
        symbol: {
          type: 'string',
          description: 'Exported symbol name (e.g., "parse", "GraphQLSchema"). Requires package.',
        },
      },
    },
  },
];
