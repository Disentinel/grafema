/**
 * Schema command - Export code schemas
 *
 * Usage:
 *   grafema schema export --interface ConfigSchema
 *   grafema schema export --interface ConfigSchema --format yaml
 *   grafema schema export --interface ConfigSchema --file src/config/types.ts
 *   grafema schema export --graph
 *   grafema schema export --graph --format yaml
 */

import { Command } from 'commander';
import { resolve, join, relative } from 'path';
import { existsSync, writeFileSync } from 'fs';
import {
  RFDBServerBackend,
  InterfaceSchemaExtractor,
  GraphSchemaExtractor,
  type InterfaceSchema,
  type GraphSchema,
  type NodeTypeSchema,
  type EdgeTypeSchema,
} from '@grafema/core';
import { exitWithError } from '../utils/errorFormatter.js';

interface ExportOptions {
  project: string;
  interface?: string;
  graph?: boolean;
  file?: string;
  format: 'json' | 'yaml' | 'markdown';
  output?: string;
}

// ============================================================================
// Interface Schema Formatters
// ============================================================================

function formatInterfaceJson(schema: InterfaceSchema): string {
  return JSON.stringify(schema, null, 2);
}

function formatInterfaceYaml(schema: InterfaceSchema): string {
  const lines: string[] = [];

  lines.push(`$schema: ${schema.$schema}`);
  lines.push(`name: ${schema.name}`);
  lines.push('source:');
  lines.push(`  file: ${schema.source.file}`);
  lines.push(`  line: ${schema.source.line}`);
  lines.push(`  column: ${schema.source.column}`);

  if (schema.typeParameters && schema.typeParameters.length > 0) {
    lines.push('typeParameters:');
    for (const param of schema.typeParameters) {
      lines.push(`  - "${param}"`);
    }
  }

  lines.push('properties:');
  for (const [name, prop] of Object.entries(schema.properties)) {
    lines.push(`  ${name}:`);
    lines.push(`    type: "${prop.type}"`);
    lines.push(`    required: ${prop.required}`);
    lines.push(`    readonly: ${prop.readonly}`);
  }

  if (schema.extends.length > 0) {
    lines.push('extends:');
    for (const ext of schema.extends) {
      lines.push(`  - ${ext}`);
    }
  } else {
    lines.push('extends: []');
  }

  lines.push(`checksum: ${schema.checksum}`);

  return lines.join('\n');
}

function formatInterfaceMarkdown(schema: InterfaceSchema, projectPath: string): string {
  const lines: string[] = [];
  const relPath = relative(projectPath, schema.source.file);

  lines.push(`# Interface: ${schema.name}`);
  lines.push('');

  if (schema.typeParameters && schema.typeParameters.length > 0) {
    lines.push(`**Type Parameters:** \`<${schema.typeParameters.join(', ')}>\``);
    lines.push('');
  }

  lines.push(`**Source:** \`${relPath}:${schema.source.line}\``);
  lines.push('');

  if (schema.extends.length > 0) {
    lines.push(`**Extends:** ${schema.extends.map(e => `\`${e}\``).join(', ')}`);
    lines.push('');
  }

  lines.push('## Properties');
  lines.push('');
  lines.push('| Name | Type | Required | Readonly |');
  lines.push('|------|------|----------|----------|');

  for (const [name, prop] of Object.entries(schema.properties)) {
    const required = prop.required ? 'Yes' : 'No';
    const readonly = prop.readonly ? 'Yes' : 'No';
    lines.push(`| \`${name}\` | \`${prop.type}\` | ${required} | ${readonly} |`);
  }

  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(`*Checksum: \`${schema.checksum}\`*`);

  return lines.join('\n');
}

/**
 * Check if schema has method properties (type='function')
 * Used to show Phase 1 limitation warning
 */
function hasMethodProperties(schema: InterfaceSchema): boolean {
  return Object.values(schema.properties).some(p => p.type === 'function');
}

// ============================================================================
// Graph Schema Formatters
// ============================================================================

function formatGraphJson(schema: GraphSchema): string {
  return JSON.stringify(schema, null, 2);
}

function formatGraphYaml(schema: GraphSchema): string {
  const lines: string[] = [];

  lines.push(`$schema: ${schema.$schema}`);
  lines.push(`extractedAt: ${schema.extractedAt}`);
  lines.push('');

  lines.push('statistics:');
  lines.push(`  totalNodes: ${schema.statistics.totalNodes}`);
  lines.push(`  totalEdges: ${schema.statistics.totalEdges}`);
  lines.push(`  nodeTypeCount: ${schema.statistics.nodeTypeCount}`);
  lines.push(`  edgeTypeCount: ${schema.statistics.edgeTypeCount}`);
  lines.push('');

  lines.push('nodeTypes:');
  for (const [type, info] of Object.entries(schema.nodeTypes) as [string, NodeTypeSchema][]) {
    if (info.count > 0) {
      lines.push(`  ${type}:`);
      lines.push(`    category: ${info.category}`);
      if (info.namespace) {
        lines.push(`    namespace: ${info.namespace}`);
      }
      lines.push(`    count: ${info.count}`);
    }
  }
  lines.push('');

  lines.push('edgeTypes:');
  for (const [type, info] of Object.entries(schema.edgeTypes) as [string, EdgeTypeSchema][]) {
    if (info.count > 0) {
      lines.push(`  ${type}:`);
      lines.push(`    count: ${info.count}`);
    }
  }
  lines.push('');

  lines.push(`checksum: ${schema.checksum}`);

  return lines.join('\n');
}

function formatGraphMarkdown(schema: GraphSchema): string {
  const lines: string[] = [];

  lines.push('# Graph Schema');
  lines.push('');
  lines.push(`**Extracted:** ${schema.extractedAt}`);
  lines.push('');

  lines.push('## Statistics');
  lines.push('');
  lines.push(`- Total Nodes: ${schema.statistics.totalNodes}`);
  lines.push(`- Total Edges: ${schema.statistics.totalEdges}`);
  lines.push(`- Node Types: ${schema.statistics.nodeTypeCount}`);
  lines.push(`- Edge Types: ${schema.statistics.edgeTypeCount}`);
  lines.push('');

  lines.push('## Node Types');
  lines.push('');
  lines.push('| Type | Category | Count |');
  lines.push('|------|----------|-------|');

  for (const [type, info] of Object.entries(schema.nodeTypes) as [string, NodeTypeSchema][]) {
    if (info.count > 0) {
      const cat = info.namespace ? `${info.category} (${info.namespace})` : info.category;
      lines.push(`| \`${type}\` | ${cat} | ${info.count} |`);
    }
  }
  lines.push('');

  lines.push('## Edge Types');
  lines.push('');
  lines.push('| Type | Count |');
  lines.push('|------|-------|');

  for (const [type, info] of Object.entries(schema.edgeTypes) as [string, EdgeTypeSchema][]) {
    if (info.count > 0) {
      lines.push(`| \`${type}\` | ${info.count} |`);
    }
  }
  lines.push('');

  lines.push('---');
  lines.push('');
  lines.push(`*Checksum: \`${schema.checksum}\`*`);

  return lines.join('\n');
}

// ============================================================================
// Command
// ============================================================================

const exportSubcommand = new Command('export')
  .description('Export interface or graph schema')
  .option('--interface <name>', 'Interface name to export')
  .option('--graph', 'Export graph node/edge type schema')
  .option('--file <path>', 'File path filter (for multiple interfaces with same name)')
  .option('-f, --format <type>', 'Output format: json, yaml, markdown', 'json')
  .option('-p, --project <path>', 'Project path', '.')
  .option('-o, --output <file>', 'Output file (default: stdout)')
  .action(async (options: ExportOptions) => {
    // Validate: must have either --interface or --graph
    if (!options.interface && !options.graph) {
      exitWithError('Must specify either --interface <name> or --graph', [
        'Examples:',
        '  grafema schema export --interface ConfigSchema',
        '  grafema schema export --graph',
      ]);
    }

    if (options.interface && options.graph) {
      exitWithError('Cannot specify both --interface and --graph', [
        'Use one at a time.',
      ]);
    }

    const projectPath = resolve(options.project);
    const grafemaDir = join(projectPath, '.grafema');
    const dbPath = join(grafemaDir, 'graph.rfdb');

    if (!existsSync(dbPath)) {
      exitWithError('No graph database found', ['Run: grafema analyze']);
    }

    const backend = new RFDBServerBackend({ dbPath });
    await backend.connect();

    try {
      if (options.graph) {
        // Graph schema export
        const extractor = new GraphSchemaExtractor(backend);
        const schema = await extractor.extract();

        let output: string;
        switch (options.format) {
          case 'yaml':
            output = formatGraphYaml(schema);
            break;
          case 'markdown':
            output = formatGraphMarkdown(schema);
            break;
          case 'json':
          default:
            output = formatGraphJson(schema);
        }

        if (options.output) {
          writeFileSync(resolve(options.output), output + '\n');
          console.log(`Graph schema written to ${options.output}`);
        } else {
          console.log(output);
        }
      } else {
        // Interface schema export
        const extractor = new InterfaceSchemaExtractor(backend);
        const schema = await extractor.extract(options.interface!, {
          file: options.file,
        });

        if (!schema) {
          exitWithError(`Interface not found: ${options.interface}`, [
            'Use "grafema query interface <name>" to search',
          ]);
        }

        // Phase 1 limitation warning for methods
        if (hasMethodProperties(schema)) {
          console.warn(
            'Note: Method signatures are shown as "function" type. ' +
              'Full signatures planned for v2.'
          );
        }

        let output: string;
        switch (options.format) {
          case 'yaml':
            output = formatInterfaceYaml(schema);
            break;
          case 'markdown':
            output = formatInterfaceMarkdown(schema, projectPath);
            break;
          case 'json':
          default:
            output = formatInterfaceJson(schema);
        }

        if (options.output) {
          writeFileSync(resolve(options.output), output + '\n');
          console.log(`Schema written to ${options.output}`);
        } else {
          console.log(output);
        }
      }
    } catch (error) {
      if (error instanceof Error) {
        exitWithError(error.message);
      }
      throw error;
    } finally {
      await backend.close();
    }
  });

export const schemaCommand = new Command('schema')
  .description('Extract and manage code schemas')
  .addCommand(exportSubcommand);
