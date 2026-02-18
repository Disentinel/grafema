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
      dependencies: ['JSASTAnalyzer'],
      creates: {
        nodes: [],
        edges: []
      }
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    const { graph } = context;
    const logger = this.log(context);

    logger.info('Starting TypeScript dead code analysis');
    const startTime = Date.now();

    const issues: DeadCodeIssue[] = [];

    // Collect all interfaces
    logger.debug('Collecting interfaces');
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
    logger.debug('Interfaces collected', { count: interfaces.size });

    // Analyze interfaces
    logger.debug('Checking implementations');
    let unusedCount = 0;
    let emptyCount = 0;
    let singleImplCount = 0;

    for (const [id, iface] of interfaces) {
      const incoming = await graph.getIncomingEdges(id, ['IMPLEMENTS', 'EXTENDS']);
      const implCount = incoming.length;
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

    logger.info('Analysis complete', { ...summary });

    // Report issues
    const warnings = issues.filter(i => i.severity === 'WARNING');
    const infos = issues.filter(i => i.severity === 'INFO');

    if (warnings.length > 0) {
      logger.warn('Warnings found', { count: warnings.length });
      for (const issue of warnings) {
        logger.warn(issue.message);
      }
    }

    if (infos.length > 0) {
      logger.info('Info messages', { count: infos.length });
      for (const issue of infos.slice(0, 5)) { // Limit to first 5
        logger.info(issue.message);
      }
      if (infos.length > 5) {
        logger.debug(`... and ${infos.length - 5} more`);
      }
    }

    if (issues.length === 0) {
      logger.info('No dead TypeScript code detected');
    }

    return createSuccessResult(
      { nodes: 0, edges: 0 },
      { summary, issues }
    );
  }
}
