/**
 * Schema command - Export code schemas
 *
 * Usage:
 *   grafema schema export --interface ConfigSchema
 *   grafema schema export --interface ConfigSchema --format yaml
 *   grafema schema export --interface ConfigSchema --file src/config/types.ts
 *   grafema schema export --interface ConfigSchema -o schema.json
 */

import { Command } from 'commander';
import { resolve, join, relative } from 'path';
import { existsSync, writeFileSync } from 'fs';
import { RFDBServerBackend, InterfaceSchemaExtractor, type InterfaceSchema } from '@grafema/core';
import { exitWithError } from '../utils/errorFormatter.js';

interface ExportOptions {
  project: string;
  interface: string;
  file?: string;
  format: 'json' | 'yaml' | 'markdown';
  output?: string;
}

// ============================================================================
// Formatters
// ============================================================================

function formatJson(schema: InterfaceSchema): string {
  return JSON.stringify(schema, null, 2);
}

function formatYaml(schema: InterfaceSchema): string {
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

function formatMarkdown(schema: InterfaceSchema, projectPath: string): string {
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
// Command
// ============================================================================

const exportSubcommand = new Command('export')
  .description('Export interface schema')
  .requiredOption('--interface <name>', 'Interface name to export (required)')
  .option('--file <path>', 'File path filter (for multiple interfaces with same name)')
  .option('-f, --format <type>', 'Output format: json, yaml, markdown', 'json')
  .option('-p, --project <path>', 'Project path', '.')
  .option('-o, --output <file>', 'Output file (default: stdout)')
  .action(async (options: ExportOptions) => {
    const projectPath = resolve(options.project);
    const grafemaDir = join(projectPath, '.grafema');
    const dbPath = join(grafemaDir, 'graph.rfdb');

    if (!existsSync(dbPath)) {
      exitWithError('No graph database found', ['Run: grafema analyze']);
    }

    const backend = new RFDBServerBackend({ dbPath });
    await backend.connect();

    try {
      const extractor = new InterfaceSchemaExtractor(backend);

      const schema = await extractor.extract(options.interface, {
        file: options.file
      });

      if (!schema) {
        exitWithError(`Interface not found: ${options.interface}`, [
          'Use "grafema query interface <name>" to search'
        ]);
      }

      // Phase 1 limitation warning for methods
      if (hasMethodProperties(schema)) {
        console.warn(
          'Note: Method signatures are shown as "function" type. ' +
          'Full signatures planned for v2.'
        );
      }

      // Format output
      let output: string;
      switch (options.format) {
        case 'yaml':
          output = formatYaml(schema);
          break;
        case 'markdown':
          output = formatMarkdown(schema, projectPath);
          break;
        case 'json':
        default:
          output = formatJson(schema);
      }

      // Write or print
      if (options.output) {
        writeFileSync(resolve(options.output), output + '\n');
        console.log(`Schema written to ${options.output}`);
      } else {
        console.log(output);
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
