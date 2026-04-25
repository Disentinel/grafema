# Joel Spolsky — Implementation Spec: REG-222 Phase 1 (Interface Schema Export)

## Overview

This spec details the implementation of interface schema export for Grafema. Based on Don's analysis and user decisions:

1. **Defaults**: Omit entirely (interfaces don't have defaults in TypeScript)
2. **Methods**: Extract full signatures `(arg1: T1, arg2: T2) => ReturnType`
3. **Generics**: Include type parameters in schema

---

## Part 1: Enhance TypeScriptVisitor for Full Method Signatures

### File: `/packages/core/src/plugins/analysis/ast/visitors/TypeScriptVisitor.ts`

**Current Behavior**: Method signatures are stored as `type: 'function'`

**Required Change**: Extract full method signature including parameters and return type

#### Step 1.1: Create helper function for method signature extraction

Add after `typeNodeToString()` function (around line 100):

```typescript
/**
 * Extracts a full method signature from TSMethodSignature node
 * Returns signature like: "(arg1: T1, arg2: T2) => ReturnType"
 */
export function methodSignatureToString(method: TSMethodSignature): string {
  const params: string[] = [];

  // Extract parameters
  if (method.parameters && method.parameters.length > 0) {
    for (const param of method.parameters) {
      if (param.type === 'Identifier') {
        const paramId = param as Identifier;
        const paramName = paramId.name;
        const paramType = paramId.typeAnnotation
          ? typeNodeToString((paramId.typeAnnotation as any).typeAnnotation)
          : 'any';
        const optional = (param as any).optional ? '?' : '';
        params.push(`${paramName}${optional}: ${paramType}`);
      } else if (param.type === 'RestElement') {
        // Handle rest parameters: ...args: T[]
        const rest = param as any;
        const paramName = rest.argument?.name || 'rest';
        const paramType = rest.typeAnnotation
          ? typeNodeToString(rest.typeAnnotation.typeAnnotation)
          : 'any[]';
        params.push(`...${paramName}: ${paramType}`);
      }
    }
  }

  // Extract return type
  const returnType = method.typeAnnotation
    ? typeNodeToString((method.typeAnnotation as any).typeAnnotation)
    : 'void';

  return `(${params.join(', ')}) => ${returnType}`;
}
```

#### Step 1.2: Update TSMethodSignature handling

Change line 165-167 from:
```typescript
properties.push({
  name: (method.key as Identifier).name,
  type: 'function',
  optional: method.optional || false,
  readonly: false
});
```

To:
```typescript
properties.push({
  name: (method.key as Identifier).name,
  type: methodSignatureToString(method),
  optional: method.optional || false,
  readonly: false
});
```

---

## Part 2: Add Generic Type Parameters Support

### File: `/packages/core/src/plugins/analysis/ast/types.ts`

#### Step 2.1: Extend InterfaceDeclarationInfo

Add `typeParameters` field (around line 174):

```typescript
export interface InterfaceDeclarationInfo {
  id?: string;
  semanticId?: string;
  type: 'INTERFACE';
  name: string;
  file: string;
  line: number;
  column?: number;
  extends?: string[];
  properties: InterfacePropertyInfo[];
  typeParameters?: string[];  // NEW: Generic type parameters, e.g., ['T', 'K extends string']
}
```

### File: `/packages/core/src/core/nodes/InterfaceNode.ts`

#### Step 2.2: Extend InterfaceNodeRecord and options

Update interface definitions:

```typescript
interface InterfacePropertyRecord {
  name: string;
  type?: string;
  optional?: boolean;
  readonly?: boolean;
}

interface InterfaceNodeRecord extends BaseNodeRecord {
  type: 'INTERFACE';
  column: number;
  extends: string[];
  properties: InterfacePropertyRecord[];
  typeParameters?: string[];  // NEW
  isExternal?: boolean;
}

interface InterfaceNodeOptions {
  extends?: string[];
  properties?: InterfacePropertyRecord[];
  typeParameters?: string[];  // NEW
  isExternal?: boolean;
}
```

Update `create()` method to pass through typeParameters:

```typescript
static create(
  name: string,
  file: string,
  line: number,
  column: number,
  options: InterfaceNodeOptions = {}
): InterfaceNodeRecord {
  // ... validation ...

  return {
    id: `${file}:INTERFACE:${name}:${line}`,
    type: this.TYPE,
    name,
    file,
    line,
    column: column || 0,
    extends: options.extends || [],
    properties: options.properties || [],
    ...(options.typeParameters && options.typeParameters.length > 0 && { typeParameters: options.typeParameters }),
    ...(options.isExternal !== undefined && { isExternal: options.isExternal })
  };
}
```

### File: `/packages/core/src/plugins/analysis/ast/visitors/TypeScriptVisitor.ts`

#### Step 2.3: Extract type parameters

Add helper function after `methodSignatureToString()`:

```typescript
/**
 * Extracts type parameter declarations from a node
 * Returns array like: ['T', 'K extends string', 'V = unknown']
 */
export function extractTypeParameters(typeParams: any): string[] {
  if (!typeParams || !typeParams.params) return [];

  return typeParams.params.map((param: any) => {
    const name = param.name;
    let result = name;

    // Handle constraint: T extends SomeType
    if (param.constraint) {
      result += ` extends ${typeNodeToString(param.constraint)}`;
    }

    // Handle default: T = DefaultType
    if (param.default) {
      result += ` = ${typeNodeToString(param.default)}`;
    }

    return result;
  });
}
```

Update TSInterfaceDeclaration handler to extract type parameters:

In the handler, after extracting `interfaceName` (around line 130), add:

```typescript
// Extract type parameters
let typeParameters: string[] | undefined;
if (node.typeParameters) {
  typeParameters = extractTypeParameters(node.typeParameters);
}
```

Update the push to interfaces (around line 175):

```typescript
(interfaces as InterfaceDeclarationInfo[]).push({
  semanticId: interfaceSemanticId,
  type: 'INTERFACE',
  name: interfaceName,
  file: module.file,
  line: getLine(node),
  column: getColumn(node),
  extends: extendsNames.length > 0 ? extendsNames : undefined,
  properties,
  typeParameters  // NEW
});
```

---

## Part 3: Create Schema Extractor Core

### File: `/packages/core/src/schema/InterfaceSchemaExtractor.ts` (NEW)

```typescript
/**
 * InterfaceSchemaExtractor - Extracts interface schemas from graph
 *
 * Usage:
 *   const extractor = new InterfaceSchemaExtractor(backend);
 *   const schema = await extractor.extract('ConfigSchema');
 *
 * When to use:
 *   - Export interface contracts for documentation
 *   - Track interface changes via checksum
 *   - Generate API documentation from graph
 */

import { createHash } from 'crypto';
import type { RFDBServerBackend } from '../storage/backends/RFDBServerBackend.js';

// ============================================================================
// Types
// ============================================================================

export interface PropertySchema {
  type: string;
  required: boolean;
  readonly: boolean;
}

export interface InterfaceSchema {
  $schema: 'grafema-interface-v1';
  name: string;
  source: {
    file: string;
    line: number;
    column: number;
  };
  typeParameters?: string[];
  properties: Record<string, PropertySchema>;
  extends: string[];
  checksum: string;
}

export interface ExtractOptions {
  /** Specific file path if multiple interfaces have same name */
  file?: string;
}

export interface InterfaceNodeRecord {
  id: string;
  type: 'INTERFACE';
  name: string;
  file: string;
  line: number;
  column: number;
  extends: string[];
  properties: Array<{
    name: string;
    type?: string;
    optional?: boolean;
    readonly?: boolean;
  }>;
  typeParameters?: string[];
}

// ============================================================================
// Extractor
// ============================================================================

export class InterfaceSchemaExtractor {
  constructor(private backend: RFDBServerBackend) {}

  /**
   * Extract schema for interface by name
   *
   * @param interfaceName - Name of the interface (e.g., 'ConfigSchema')
   * @param options - Optional filters
   * @returns InterfaceSchema or null if not found
   * @throws Error if multiple interfaces match and no file specified
   */
  async extract(interfaceName: string, options?: ExtractOptions): Promise<InterfaceSchema | null> {
    const interfaces = await this.findInterfaces(interfaceName);

    if (interfaces.length === 0) {
      return null;
    }

    // Filter by file if specified
    let match: InterfaceNodeRecord;
    if (options?.file) {
      const filtered = interfaces.filter(i => i.file === options.file || i.file.endsWith(options.file));
      if (filtered.length === 0) {
        return null;
      }
      match = filtered[0];
    } else if (interfaces.length > 1) {
      const locations = interfaces.map(i => `  - ${i.file}:${i.line}`).join('\n');
      throw new Error(
        `Multiple interfaces named "${interfaceName}" found:\n${locations}\n` +
        `Use --file option to specify which one.`
      );
    } else {
      match = interfaces[0];
    }

    return this.buildSchema(match);
  }

  /**
   * Find all interfaces with given name
   */
  async findInterfaces(name: string): Promise<InterfaceNodeRecord[]> {
    const result: InterfaceNodeRecord[] = [];

    for await (const node of this.backend.queryNodes({ nodeType: 'INTERFACE' })) {
      if (node.name === name) {
        result.push(node as unknown as InterfaceNodeRecord);
      }
    }

    return result;
  }

  /**
   * Build InterfaceSchema from node record
   */
  private buildSchema(node: InterfaceNodeRecord): InterfaceSchema {
    // Sort properties alphabetically for deterministic output
    const sortedProperties = [...(node.properties || [])].sort((a, b) =>
      a.name.localeCompare(b.name)
    );

    const properties: Record<string, PropertySchema> = {};
    for (const prop of sortedProperties) {
      properties[prop.name] = {
        type: prop.type || 'unknown',
        required: !prop.optional,
        readonly: prop.readonly || false
      };
    }

    // Compute checksum from normalized content
    const checksumContent = {
      name: node.name,
      properties: sortedProperties.map(p => ({
        name: p.name,
        type: p.type,
        optional: p.optional,
        readonly: p.readonly
      })),
      extends: [...(node.extends || [])].sort(),
      typeParameters: node.typeParameters
    };

    const checksum = createHash('sha256')
      .update(JSON.stringify(checksumContent))
      .digest('hex');

    return {
      $schema: 'grafema-interface-v1',
      name: node.name,
      source: {
        file: node.file,
        line: node.line,
        column: node.column
      },
      ...(node.typeParameters && node.typeParameters.length > 0 && {
        typeParameters: node.typeParameters
      }),
      properties,
      extends: node.extends || [],
      checksum: `sha256:${checksum}`
    };
  }
}
```

### File: `/packages/core/src/schema/index.ts` (NEW)

```typescript
export { InterfaceSchemaExtractor, type InterfaceSchema, type PropertySchema, type ExtractOptions } from './InterfaceSchemaExtractor.js';
```

### Update: `/packages/core/src/index.ts`

Add export:

```typescript
export * from './schema/index.js';
```

---

## Part 4: Create CLI Command

### File: `/packages/cli/src/commands/schema.ts` (NEW)

```typescript
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
  interface?: string;
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

// ============================================================================
// Command
// ============================================================================

const exportSubcommand = new Command('export')
  .description('Export interface schema')
  .option('--interface <name>', 'Interface name to export')
  .option('--file <path>', 'File path filter (for multiple interfaces with same name)')
  .option('-f, --format <type>', 'Output format: json, yaml, markdown', 'json')
  .option('-p, --project <path>', 'Project path', '.')
  .option('-o, --output <file>', 'Output file (default: stdout)')
  .action(async (options: ExportOptions) => {
    if (!options.interface) {
      exitWithError('Interface name required', [
        'Usage: grafema schema export --interface <name>',
        'Example: grafema schema export --interface ConfigSchema'
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
      const extractor = new InterfaceSchemaExtractor(backend);

      const schema = await extractor.extract(options.interface, {
        file: options.file
      });

      if (!schema) {
        exitWithError(`Interface not found: ${options.interface}`, [
          'Use "grafema query interface <name>" to search'
        ]);
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
```

### Update: `/packages/cli/src/cli.ts`

Add import and register command:

```typescript
import { schemaCommand } from './commands/schema.js';

// Add after other commands
program.addCommand(schemaCommand);
```

---

## Part 5: GraphBuilder Integration

### File: `/packages/core/src/plugins/analysis/ast/GraphBuilder.ts`

The `bufferInterfaceNodes` method (around line 1181) already handles interface nodes. We need to ensure it passes `typeParameters` to `InterfaceNode.create()`.

Find the `bufferInterfaceNodes` method and update the `InterfaceNode.create()` call:

```typescript
private bufferInterfaceNodes(module: ModuleNode, interfaces: InterfaceDeclarationInfo[]): void {
  const interfaceNodes = new Map<string, InterfaceNodeRecord>();

  for (const iface of interfaces) {
    const interfaceNode = InterfaceNode.create(
      iface.name,
      module.file,
      iface.line,
      iface.column || 0,
      {
        extends: iface.extends || [],
        properties: iface.properties.map(p => ({
          name: p.name,
          type: p.type,
          optional: p.optional,
          readonly: p.readonly
        })),
        typeParameters: iface.typeParameters  // NEW
      }
    );
    // ... rest of method
  }
}
```

---

## Part 6: Tests

### File: `/test/unit/schema/InterfaceSchemaExtractor.test.ts` (NEW)

```typescript
/**
 * InterfaceSchemaExtractor Tests
 *
 * Tests for interface schema extraction from graph.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import type { InterfaceSchema } from '@grafema/core';

// Mock backend for testing
class MockBackend {
  private nodes: Map<string, any> = new Map();

  addInterface(node: any): void {
    this.nodes.set(node.id, node);
  }

  async *queryNodes(filter: { nodeType: string }): AsyncGenerator<any> {
    for (const node of this.nodes.values()) {
      if (node.type === filter.nodeType) {
        yield node;
      }
    }
  }
}

// Will import after implementation
// import { InterfaceSchemaExtractor } from '@grafema/core';

describe('InterfaceSchemaExtractor', () => {
  describe('extract()', () => {
    it('should extract simple interface with flat properties', async () => {
      const backend = new MockBackend();
      backend.addInterface({
        id: '/src/types.ts:INTERFACE:Config:5',
        type: 'INTERFACE',
        name: 'Config',
        file: '/src/types.ts',
        line: 5,
        column: 1,
        extends: [],
        properties: [
          { name: 'host', type: 'string', optional: false, readonly: false },
          { name: 'port', type: 'number', optional: false, readonly: false }
        ]
      });

      // const extractor = new InterfaceSchemaExtractor(backend as any);
      // const schema = await extractor.extract('Config');

      // assert.ok(schema);
      // assert.strictEqual(schema.name, 'Config');
      // assert.strictEqual(schema.$schema, 'grafema-interface-v1');
      // assert.strictEqual(schema.properties.host.type, 'string');
      // assert.strictEqual(schema.properties.port.required, true);
    });

    it('should extract interface with optional properties', async () => {
      const backend = new MockBackend();
      backend.addInterface({
        id: '/src/types.ts:INTERFACE:Options:10',
        type: 'INTERFACE',
        name: 'Options',
        file: '/src/types.ts',
        line: 10,
        column: 1,
        extends: [],
        properties: [
          { name: 'debug', type: 'boolean', optional: true, readonly: false }
        ]
      });

      // const extractor = new InterfaceSchemaExtractor(backend as any);
      // const schema = await extractor.extract('Options');

      // assert.strictEqual(schema?.properties.debug.required, false);
    });

    it('should extract interface with readonly properties', async () => {
      const backend = new MockBackend();
      backend.addInterface({
        id: '/src/types.ts:INTERFACE:Immutable:15',
        type: 'INTERFACE',
        name: 'Immutable',
        file: '/src/types.ts',
        line: 15,
        column: 1,
        extends: [],
        properties: [
          { name: 'id', type: 'string', optional: false, readonly: true }
        ]
      });

      // const extractor = new InterfaceSchemaExtractor(backend as any);
      // const schema = await extractor.extract('Immutable');

      // assert.strictEqual(schema?.properties.id.readonly, true);
    });

    it('should extract interface with extends', async () => {
      const backend = new MockBackend();
      backend.addInterface({
        id: '/src/types.ts:INTERFACE:Extended:20',
        type: 'INTERFACE',
        name: 'Extended',
        file: '/src/types.ts',
        line: 20,
        column: 1,
        extends: ['Base', 'Mixin'],
        properties: []
      });

      // const extractor = new InterfaceSchemaExtractor(backend as any);
      // const schema = await extractor.extract('Extended');

      // assert.deepStrictEqual(schema?.extends, ['Base', 'Mixin']);
    });

    it('should extract interface with method signatures', async () => {
      const backend = new MockBackend();
      backend.addInterface({
        id: '/src/types.ts:INTERFACE:Service:25',
        type: 'INTERFACE',
        name: 'Service',
        file: '/src/types.ts',
        line: 25,
        column: 1,
        extends: [],
        properties: [
          { name: 'getData', type: '(id: string) => Promise', optional: false, readonly: false },
          { name: 'setData', type: '(id: string, value: any) => void', optional: false, readonly: false }
        ]
      });

      // const extractor = new InterfaceSchemaExtractor(backend as any);
      // const schema = await extractor.extract('Service');

      // assert.strictEqual(schema?.properties.getData.type, '(id: string) => Promise');
    });

    it('should extract interface with type parameters', async () => {
      const backend = new MockBackend();
      backend.addInterface({
        id: '/src/types.ts:INTERFACE:Response:30',
        type: 'INTERFACE',
        name: 'Response',
        file: '/src/types.ts',
        line: 30,
        column: 1,
        extends: [],
        properties: [
          { name: 'data', type: 'T', optional: false, readonly: false }
        ],
        typeParameters: ['T', 'E extends Error']
      });

      // const extractor = new InterfaceSchemaExtractor(backend as any);
      // const schema = await extractor.extract('Response');

      // assert.deepStrictEqual(schema?.typeParameters, ['T', 'E extends Error']);
    });

    it('should return null for non-existent interface', async () => {
      const backend = new MockBackend();

      // const extractor = new InterfaceSchemaExtractor(backend as any);
      // const schema = await extractor.extract('NonExistent');

      // assert.strictEqual(schema, null);
    });

    it('should throw error for ambiguous name (multiple files)', async () => {
      const backend = new MockBackend();
      backend.addInterface({
        id: '/src/a.ts:INTERFACE:Config:5',
        type: 'INTERFACE',
        name: 'Config',
        file: '/src/a.ts',
        line: 5,
        column: 1,
        extends: [],
        properties: []
      });
      backend.addInterface({
        id: '/src/b.ts:INTERFACE:Config:10',
        type: 'INTERFACE',
        name: 'Config',
        file: '/src/b.ts',
        line: 10,
        column: 1,
        extends: [],
        properties: []
      });

      // const extractor = new InterfaceSchemaExtractor(backend as any);
      // await assert.rejects(
      //   () => extractor.extract('Config'),
      //   /Multiple interfaces named "Config" found/
      // );
    });

    it('should resolve ambiguity with file option', async () => {
      const backend = new MockBackend();
      backend.addInterface({
        id: '/src/a.ts:INTERFACE:Config:5',
        type: 'INTERFACE',
        name: 'Config',
        file: '/src/a.ts',
        line: 5,
        column: 1,
        extends: [],
        properties: []
      });
      backend.addInterface({
        id: '/src/b.ts:INTERFACE:Config:10',
        type: 'INTERFACE',
        name: 'Config',
        file: '/src/b.ts',
        line: 10,
        column: 1,
        extends: [],
        properties: []
      });

      // const extractor = new InterfaceSchemaExtractor(backend as any);
      // const schema = await extractor.extract('Config', { file: '/src/a.ts' });

      // assert.strictEqual(schema?.source.file, '/src/a.ts');
    });

    it('should produce deterministic checksum', async () => {
      const backend = new MockBackend();
      backend.addInterface({
        id: '/src/types.ts:INTERFACE:Config:5',
        type: 'INTERFACE',
        name: 'Config',
        file: '/src/types.ts',
        line: 5,
        column: 1,
        extends: [],
        properties: [
          { name: 'b', type: 'string', optional: false, readonly: false },
          { name: 'a', type: 'number', optional: false, readonly: false }
        ]
      });

      // const extractor = new InterfaceSchemaExtractor(backend as any);
      // const schema1 = await extractor.extract('Config');
      // const schema2 = await extractor.extract('Config');

      // assert.strictEqual(schema1?.checksum, schema2?.checksum);
      // Properties should be sorted, so order in source doesn't matter
    });
  });
});
```

### File: `/test/unit/visitors/TypeScriptVisitor.test.ts` (NEW or extend existing)

```typescript
/**
 * TypeScriptVisitor Tests - Method Signature Extraction
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
// import { methodSignatureToString, extractTypeParameters } from '@grafema/core';

describe('TypeScriptVisitor - Method Signatures', () => {
  describe('methodSignatureToString()', () => {
    it('should extract simple method signature', () => {
      // Mock TSMethodSignature node
      const method = {
        type: 'TSMethodSignature',
        key: { type: 'Identifier', name: 'getData' },
        parameters: [],
        typeAnnotation: {
          type: 'TSTypeAnnotation',
          typeAnnotation: { type: 'TSVoidKeyword' }
        }
      };

      // const result = methodSignatureToString(method);
      // assert.strictEqual(result, '() => void');
    });

    it('should extract method with typed parameters', () => {
      const method = {
        type: 'TSMethodSignature',
        key: { type: 'Identifier', name: 'setData' },
        parameters: [
          {
            type: 'Identifier',
            name: 'id',
            typeAnnotation: {
              type: 'TSTypeAnnotation',
              typeAnnotation: { type: 'TSStringKeyword' }
            }
          },
          {
            type: 'Identifier',
            name: 'value',
            typeAnnotation: {
              type: 'TSTypeAnnotation',
              typeAnnotation: { type: 'TSAnyKeyword' }
            }
          }
        ],
        typeAnnotation: {
          type: 'TSTypeAnnotation',
          typeAnnotation: { type: 'TSVoidKeyword' }
        }
      };

      // const result = methodSignatureToString(method);
      // assert.strictEqual(result, '(id: string, value: any) => void');
    });

    it('should handle optional parameters', () => {
      const method = {
        type: 'TSMethodSignature',
        key: { type: 'Identifier', name: 'search' },
        parameters: [
          {
            type: 'Identifier',
            name: 'query',
            typeAnnotation: {
              type: 'TSTypeAnnotation',
              typeAnnotation: { type: 'TSStringKeyword' }
            }
          },
          {
            type: 'Identifier',
            name: 'limit',
            optional: true,
            typeAnnotation: {
              type: 'TSTypeAnnotation',
              typeAnnotation: { type: 'TSNumberKeyword' }
            }
          }
        ],
        typeAnnotation: {
          type: 'TSTypeAnnotation',
          typeAnnotation: {
            type: 'TSArrayType',
            elementType: { type: 'TSStringKeyword' }
          }
        }
      };

      // const result = methodSignatureToString(method);
      // assert.strictEqual(result, '(query: string, limit?: number) => string[]');
    });

    it('should handle rest parameters', () => {
      const method = {
        type: 'TSMethodSignature',
        key: { type: 'Identifier', name: 'concat' },
        parameters: [
          {
            type: 'RestElement',
            argument: { type: 'Identifier', name: 'items' },
            typeAnnotation: {
              type: 'TSTypeAnnotation',
              typeAnnotation: {
                type: 'TSArrayType',
                elementType: { type: 'TSStringKeyword' }
              }
            }
          }
        ],
        typeAnnotation: {
          type: 'TSTypeAnnotation',
          typeAnnotation: { type: 'TSStringKeyword' }
        }
      };

      // const result = methodSignatureToString(method);
      // assert.strictEqual(result, '(...items: string[]) => string');
    });
  });

  describe('extractTypeParameters()', () => {
    it('should extract simple type parameter', () => {
      const typeParams = {
        type: 'TSTypeParameterDeclaration',
        params: [
          { type: 'TSTypeParameter', name: 'T' }
        ]
      };

      // const result = extractTypeParameters(typeParams);
      // assert.deepStrictEqual(result, ['T']);
    });

    it('should extract type parameter with constraint', () => {
      const typeParams = {
        type: 'TSTypeParameterDeclaration',
        params: [
          {
            type: 'TSTypeParameter',
            name: 'K',
            constraint: { type: 'TSStringKeyword' }
          }
        ]
      };

      // const result = extractTypeParameters(typeParams);
      // assert.deepStrictEqual(result, ['K extends string']);
    });

    it('should extract type parameter with default', () => {
      const typeParams = {
        type: 'TSTypeParameterDeclaration',
        params: [
          {
            type: 'TSTypeParameter',
            name: 'T',
            default: { type: 'TSUnknownKeyword' }
          }
        ]
      };

      // const result = extractTypeParameters(typeParams);
      // assert.deepStrictEqual(result, ['T = unknown']);
    });

    it('should extract multiple type parameters', () => {
      const typeParams = {
        type: 'TSTypeParameterDeclaration',
        params: [
          { type: 'TSTypeParameter', name: 'T' },
          {
            type: 'TSTypeParameter',
            name: 'K',
            constraint: { type: 'TSStringKeyword' }
          },
          {
            type: 'TSTypeParameter',
            name: 'V',
            default: { type: 'TSAnyKeyword' }
          }
        ]
      };

      // const result = extractTypeParameters(typeParams);
      // assert.deepStrictEqual(result, ['T', 'K extends string', 'V = any']);
    });
  });
});
```

---

## Implementation Order

1. **Phase 1A: Type Definitions** (no behavioral changes)
   - Add `typeParameters` to `InterfaceDeclarationInfo` in types.ts
   - Add `typeParameters` to `InterfaceNodeRecord` in InterfaceNode.ts
   - Update `InterfaceNode.create()` to accept typeParameters

2. **Phase 1B: TypeScriptVisitor Enhancement**
   - Add `methodSignatureToString()` helper function
   - Add `extractTypeParameters()` helper function
   - Update TSInterfaceDeclaration handler to use new functions
   - Write tests for visitor functions

3. **Phase 1C: GraphBuilder Update**
   - Update `bufferInterfaceNodes()` to pass typeParameters

4. **Phase 1D: Schema Extractor Core**
   - Create `/packages/core/src/schema/InterfaceSchemaExtractor.ts`
   - Create `/packages/core/src/schema/index.ts`
   - Update `/packages/core/src/index.ts` with exports
   - Write unit tests

5. **Phase 1E: CLI Command**
   - Create `/packages/cli/src/commands/schema.ts`
   - Update `/packages/cli/src/cli.ts`
   - Manual integration testing

---

## Edge Cases to Handle

1. **Anonymous interfaces** (object type literals): Skip, only named interfaces
2. **Nested interfaces** (interface inside class): Handle via semantic ID
3. **Re-exported interfaces**: Follow EXPORT -> INTERFACE edges
4. **Merged interfaces** (declaration merging): Show warning, list all locations
5. **External interfaces** (`isExternal: true`): Include with warning
6. **Index signatures** (`[key: string]: any`): Store as special property `[index]`
7. **Call signatures** (`(): void`): Store as property `[[call]]`
8. **Construct signatures** (`new(): T`): Store as property `[[construct]]`

---

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Babel AST changes | Medium | Pin @babel/types version, add type guards |
| Large graphs slow query | Low | queryNodes is already streaming |
| YAML format edge cases | Low | Use simple key-value, test special chars |

---

*"The details are not the details. They make the design."*

This spec provides everything needed for implementation. Each step is atomic and testable.
