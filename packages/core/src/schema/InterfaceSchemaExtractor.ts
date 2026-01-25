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
      const fileFilter = options.file;
      const filtered = interfaces.filter(i => i.file === fileFilter || i.file.endsWith(fileFilter));
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
