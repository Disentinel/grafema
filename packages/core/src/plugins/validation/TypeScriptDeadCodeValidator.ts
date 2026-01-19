/**
 * TypeScriptDeadCodeValidator - detects unused TypeScript constructs
 *
 * Checks:
 * - Unused interfaces (no IMPLEMENTS edges)
 * - Empty interfaces (no properties)
 * - Interfaces with single implementation (possible over-engineering)
 * - Unused enums (no references) - requires USES_TYPE edges
 * - Unused type aliases (no references) - requires USES_TYPE edges
 *
 * NOTE: Full "unused type" detection requires USES_TYPE edges which track
 * where types are used in function parameters, return types, and variables.
 * Currently we can only detect interfaces without implementations.
 */

import { Plugin, createSuccessResult } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';

/**
 * Dead code issue
 */
interface DeadCodeIssue {
  type: 'UNUSED_INTERFACE' | 'EMPTY_INTERFACE' | 'SINGLE_IMPLEMENTATION' | 'UNUSED_ENUM' | 'UNUSED_TYPE';
  severity: 'WARNING' | 'INFO';
  message: string;
  nodeId: string;
  name: string;
  file?: string;
  line?: number;
}

/**
 * Validation summary
 */
interface ValidationSummary {
  totalInterfaces: number;
  unusedInterfaces: number;
  emptyInterfaces: number;
  singleImplInterfaces: number;
  totalEnums: number;
  totalTypes: number;
  timeSeconds: string;
}

export class TypeScriptDeadCodeValidator extends Plugin {
  get metadata(): PluginMetadata {
    return {
      name: 'TypeScriptDeadCodeValidator',
      phase: 'VALIDATION',
      priority: 50, // Lower priority - runs after other validators
      creates: {
        nodes: [],
        edges: []
      },
      dependencies: ['JSASTAnalyzer'] // Requires TypeScript nodes to be created
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    const { graph } = context;

    console.log('[TypeScriptDeadCodeValidator] Checking for dead TypeScript code...');
    const startTime = Date.now();

    const issues: DeadCodeIssue[] = [];

    // Collect all interfaces
    console.log('[TypeScriptDeadCodeValidator] Collecting interfaces...');
    const interfaces: Map<string, { id: string; name: string; file?: string; line?: number; properties?: unknown[] }> = new Map();

    for await (const node of graph.queryNodes({ nodeType: 'INTERFACE' })) {
      // Skip external/reference interfaces
      if ((node as { isExternal?: boolean }).isExternal) continue;

      interfaces.set(node.id, {
        id: node.id,
        name: node.name as string,
        file: node.file,
        line: node.line as number | undefined,
        properties: (node as { properties?: unknown[] }).properties
      });
    }
    console.log(`[TypeScriptDeadCodeValidator] Found ${interfaces.size} interfaces`);

    // Find interfaces with IMPLEMENTS or EXTENDS edges
    console.log('[TypeScriptDeadCodeValidator] Checking implementations...');
    const implementedInterfaces: Map<string, number> = new Map();

    // Get all edges and filter by type (no queryEdges in GraphBackend yet)
    const allEdges = await graph.getAllEdges?.() ?? [];
    for (const edge of allEdges) {
      if (edge.type === 'IMPLEMENTS' || edge.type === 'EXTENDS') {
        const count = implementedInterfaces.get(edge.dst) || 0;
        implementedInterfaces.set(edge.dst, count + 1);
      }
    }

    // Analyze interfaces
    let unusedCount = 0;
    let emptyCount = 0;
    let singleImplCount = 0;

    for (const [id, iface] of interfaces) {
      const implCount = implementedInterfaces.get(id) || 0;
      const properties = iface.properties || [];

      // Check for empty interface
      if (properties.length === 0) {
        emptyCount++;
        issues.push({
          type: 'EMPTY_INTERFACE',
          severity: 'INFO',
          message: `Empty interface '${iface.name}' at ${iface.file}:${iface.line || '?'} - consider using type alias or removing`,
          nodeId: id,
          name: iface.name,
          file: iface.file,
          line: iface.line
        });
      }

      // Check for unused interface (no implementations)
      if (implCount === 0) {
        unusedCount++;
        issues.push({
          type: 'UNUSED_INTERFACE',
          severity: 'WARNING',
          message: `Interface '${iface.name}' at ${iface.file}:${iface.line || '?'} has no implementations`,
          nodeId: id,
          name: iface.name,
          file: iface.file,
          line: iface.line
        });
      }
      // Check for single implementation (possible over-engineering)
      else if (implCount === 1) {
        singleImplCount++;
        issues.push({
          type: 'SINGLE_IMPLEMENTATION',
          severity: 'INFO',
          message: `Interface '${iface.name}' at ${iface.file}:${iface.line || '?'} has only one implementation - may be over-engineering`,
          nodeId: id,
          name: iface.name,
          file: iface.file,
          line: iface.line
        });
      }
    }

    // Count enums and types (for summary, full analysis requires USES_TYPE)
    let enumCount = 0;
    for await (const _node of graph.queryNodes({ nodeType: 'ENUM' })) {
      enumCount++;
    }

    let typeCount = 0;
    for await (const _node of graph.queryNodes({ nodeType: 'TYPE' })) {
      typeCount++;
    }

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
    const summary: ValidationSummary = {
      totalInterfaces: interfaces.size,
      unusedInterfaces: unusedCount,
      emptyInterfaces: emptyCount,
      singleImplInterfaces: singleImplCount,
      totalEnums: enumCount,
      totalTypes: typeCount,
      timeSeconds: totalTime
    };

    console.log('[TypeScriptDeadCodeValidator] Summary:', summary);

    // Report issues
    const warnings = issues.filter(i => i.severity === 'WARNING');
    const infos = issues.filter(i => i.severity === 'INFO');

    if (warnings.length > 0) {
      console.log(`[TypeScriptDeadCodeValidator] ⚠️  ${warnings.length} warning(s):`);
      for (const issue of warnings) {
        console.log(`  ⚠️  ${issue.message}`);
      }
    }

    if (infos.length > 0) {
      console.log(`[TypeScriptDeadCodeValidator] ℹ️  ${infos.length} info(s):`);
      for (const issue of infos.slice(0, 5)) { // Limit to first 5
        console.log(`  ℹ️  ${issue.message}`);
      }
      if (infos.length > 5) {
        console.log(`  ... and ${infos.length - 5} more`);
      }
    }

    if (issues.length === 0) {
      console.log('[TypeScriptDeadCodeValidator] ✅ No dead TypeScript code detected');
    }

    return createSuccessResult(
      { nodes: 0, edges: 0 },
      { summary, issues }
    );
  }
}
