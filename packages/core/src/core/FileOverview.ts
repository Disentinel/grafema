/**
 * FileOverview - Get a structured overview of all entities in a file.
 *
 * Purpose: Show what a file contains and how its parts relate to each other.
 * Unlike FileExplainer (which lists ALL nodes flat), FileOverview shows only
 * meaningful entities (functions, classes, variables) with their key relationships
 * (calls, extends, assigned-from).
 *
 * Unlike the context command (which shows ONE node's full neighborhood),
 * FileOverview shows ALL entities at file level with curated edges.
 *
 * Use this when:
 * - AI agent needs to understand a file before diving deeper
 * - User wants a table-of-contents of a file with relationships
 * - Quick orientation before using get_context on specific nodes
 *
 * @example
 * ```typescript
 * const overview = new FileOverview(backend);
 * const result = await overview.getOverview('/abs/path/to/file.js');
 * // result.functions[0].calls -> ["express", "Router"]
 * ```
 *
 * @see REG-412
 */

import type { GraphBackend, BaseNodeRecord, NodeFilter } from '@grafema/types';
import type { CallInfo } from '../queries/types.js';
import { findCallsInFunction } from '../queries/findCallsInFunction.js';

// === Result Types ===

export interface ImportInfo {
  id: string;
  source: string;
  specifiers: string[];
}

export interface ExportInfo {
  id: string;
  name: string;
  isDefault: boolean;
}

export interface FunctionOverview {
  id: string;
  name: string;
  line?: number;
  async: boolean;
  params?: string[];
  calls: string[];
  returnType?: string;
  signature?: string;
}

export interface ClassOverview {
  id: string;
  name: string;
  line?: number;
  extends?: string;
  exported: boolean;
  methods: FunctionOverview[];
}

export interface VariableOverview {
  id: string;
  name: string;
  line?: number;
  kind: string;
  assignedFrom?: string;
}

export interface FileOverviewResult {
  file: string;
  status: 'ANALYZED' | 'NOT_ANALYZED';
  imports: ImportInfo[];
  exports: ExportInfo[];
  classes: ClassOverview[];
  functions: FunctionOverview[];
  variables: VariableOverview[];
}

/** Node types we display in the file overview */
const OVERVIEW_NODE_TYPES = new Set([
  'FUNCTION',
  'CLASS',
  'METHOD',
  'VARIABLE',
  'CONSTANT',
  'IMPORT',
  'EXPORT',
]);

export class FileOverview {
  constructor(private graph: GraphBackend) {}

  /**
   * Get structured overview of a file's entities and relationships.
   *
   * @param filePath - Absolute file path (after realpath resolution)
   * @param options - Optional: { includeEdges: boolean }
   * @returns FileOverviewResult
   */
  async getOverview(
    filePath: string,
    options: { includeEdges?: boolean } = {}
  ): Promise<FileOverviewResult> {
    const { includeEdges = true } = options;

    const moduleNode = await this.findModuleNode(filePath);
    if (!moduleNode) {
      return {
        file: filePath,
        status: 'NOT_ANALYZED',
        imports: [],
        exports: [],
        classes: [],
        functions: [],
        variables: [],
      };
    }

    const children = await this.getTopLevelEntities(moduleNode.id);

    const imports: ImportInfo[] = [];
    const exports: ExportInfo[] = [];
    const classes: ClassOverview[] = [];
    const functions: FunctionOverview[] = [];
    const variables: VariableOverview[] = [];

    for (const child of children) {
      switch (child.type) {
        case 'IMPORT':
          imports.push(this.buildImportInfo(child));
          break;
        case 'EXPORT':
          exports.push(this.buildExportInfo(child));
          break;
        case 'CLASS':
          classes.push(await this.buildClassOverview(child, includeEdges));
          break;
        case 'FUNCTION':
        case 'METHOD':
          functions.push(await this.buildFunctionOverview(child, includeEdges));
          break;
        case 'VARIABLE':
        case 'CONSTANT':
          variables.push(await this.buildVariableOverview(child, includeEdges));
          break;
      }
    }

    const byLine = (a: { line?: number }, b: { line?: number }) =>
      (a.line ?? 0) - (b.line ?? 0);

    classes.sort(byLine);
    functions.sort(byLine);
    variables.sort(byLine);

    return {
      file: filePath,
      status: 'ANALYZED',
      imports,
      exports,
      classes,
      functions,
      variables,
    };
  }

  /**
   * Find the MODULE node for the given file path.
   * Complexity: O(1) - server-side filtered query
   */
  private async findModuleNode(
    filePath: string
  ): Promise<BaseNodeRecord | null> {
    const filter: NodeFilter = { file: filePath, type: 'MODULE' };
    for await (const node of this.graph.queryNodes(filter)) {
      if (node.file === filePath && node.type === 'MODULE') {
        return node;
      }
    }
    return null;
  }

  /**
   * Get direct children of MODULE node that are "interesting" types.
   * Complexity: O(C) where C = total CONTAINS edges from MODULE
   */
  private async getTopLevelEntities(
    moduleId: string
  ): Promise<BaseNodeRecord[]> {
    const containsEdges = await this.graph.getOutgoingEdges(
      moduleId,
      ['CONTAINS']
    );

    const entities: BaseNodeRecord[] = [];
    for (const edge of containsEdges) {
      const child = await this.graph.getNode(edge.dst);
      if (child && OVERVIEW_NODE_TYPES.has(child.type)) {
        entities.push(child);
      }
    }
    return entities;
  }

  /**
   * Build ImportInfo from an IMPORT node.
   * Data read directly from node record fields.
   * Complexity: O(1)
   */
  private buildImportInfo(node: BaseNodeRecord): ImportInfo {
    const source = (node.source as string) ?? (node.name || '');
    const rawSpecifiers = node.specifiers;
    let specifierNames: string[] = [];

    if (Array.isArray(rawSpecifiers)) {
      specifierNames = rawSpecifiers.map(
        (s: { local?: string; imported?: string; type?: string }) =>
          s.local || s.imported || 'unknown'
      );
    }

    return {
      id: node.id,
      source,
      specifiers: specifierNames,
    };
  }

  /**
   * Build ExportInfo from an EXPORT node.
   * Data read directly from node record fields.
   * Complexity: O(1)
   */
  private buildExportInfo(node: BaseNodeRecord): ExportInfo {
    return {
      id: node.id,
      name: (node.exportedName as string) ?? node.name ?? '<anonymous>',
      isDefault: (node.isDefault as boolean) ?? false,
    };
  }

  /**
   * Build FunctionOverview from a FUNCTION node.
   * When includeEdges=true, resolves calls via findCallsInFunction.
   * Complexity: Without edges O(1), with edges O(S + C)
   */
  private async buildFunctionOverview(
    node: BaseNodeRecord,
    includeEdges: boolean
  ): Promise<FunctionOverview> {
    const overview: FunctionOverview = {
      id: node.id,
      name: node.name ?? '<anonymous>',
      line: node.line as number | undefined,
      async: (node.async as boolean) ?? false,
      params: node.params as string[] | undefined,
      calls: [],
      returnType: node.returnType as string | undefined,
      signature: node.signature as string | undefined,
    };

    if (includeEdges) {
      const callInfos: CallInfo[] = await findCallsInFunction(
        this.graph,
        node.id,
        { transitive: false }
      );

      const callNames = new Set<string>();
      for (const call of callInfos) {
        if (call.resolved && call.target) {
          callNames.add(call.target.name);
        } else {
          callNames.add(call.name);
        }
      }
      overview.calls = Array.from(callNames);
    }

    return overview;
  }

  /**
   * Build ClassOverview from a CLASS node.
   * Fetches EXTENDS edge and methods via CONTAINS.
   * Complexity: Without edges O(M), with edges O(M * (S + C))
   */
  private async buildClassOverview(
    node: BaseNodeRecord,
    includeEdges: boolean
  ): Promise<ClassOverview> {
    const overview: ClassOverview = {
      id: node.id,
      name: node.name ?? '<anonymous>',
      line: node.line as number | undefined,
      exported: (node.exported as boolean) ?? false,
      methods: [],
    };

    // Get superclass
    if (includeEdges) {
      const extendsEdges = await this.graph.getOutgoingEdges(
        node.id,
        ['EXTENDS']
      );
      if (extendsEdges.length > 0) {
        const superNode = await this.graph.getNode(extendsEdges[0].dst);
        overview.extends = superNode?.name ?? (node.superClass as string);
      } else if (node.superClass) {
        overview.extends = node.superClass as string;
      }
    } else if (node.superClass) {
      overview.extends = node.superClass as string;
    }

    // Get methods via CONTAINS edges
    const containsEdges = await this.graph.getOutgoingEdges(
      node.id,
      ['CONTAINS']
    );

    for (const edge of containsEdges) {
      const child = await this.graph.getNode(edge.dst);
      if (!child) continue;

      if (child.type === 'FUNCTION' || child.type === 'METHOD') {
        const methodOverview = await this.buildFunctionOverview(
          child,
          includeEdges
        );
        overview.methods.push(methodOverview);
      }
    }

    overview.methods.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));

    return overview;
  }

  /**
   * Build VariableOverview from a VARIABLE or CONSTANT node.
   * Complexity: Without edges O(1), with edges O(1)
   */
  private async buildVariableOverview(
    node: BaseNodeRecord,
    includeEdges: boolean
  ): Promise<VariableOverview> {
    const overview: VariableOverview = {
      id: node.id,
      name: node.name ?? '<anonymous>',
      line: node.line as number | undefined,
      kind: (node.kind as string) ?? 'const',
    };

    if (includeEdges) {
      const assignedEdges = await this.graph.getOutgoingEdges(
        node.id,
        ['ASSIGNED_FROM']
      );
      if (assignedEdges.length > 0) {
        const sourceNode = await this.graph.getNode(assignedEdges[0].dst);
        if (sourceNode) {
          overview.assignedFrom = sourceNode.name ?? sourceNode.type;
        }
      }
    }

    return overview;
  }
}
