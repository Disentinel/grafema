/**
 * CallResolverValidator - validates function call resolution (REG-227)
 *
 * Checks that all function calls are properly resolved:
 * - Internal calls: CALLS edge to FUNCTION node
 * - External calls: CALLS edge to EXTERNAL_MODULE node
 * - Builtin calls: recognized by name (no edge needed)
 * - Unresolved: no edge, not builtin -> WARNING
 *
 * This validator runs AFTER FunctionCallResolver and ExternalCallResolver
 * to verify resolution quality and report issues.
 */

import { Plugin, createSuccessResult } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';
import type { BaseNodeRecord } from '@grafema/types';
import { ValidationError } from '../../errors/GrafemaError.js';
import { JS_GLOBAL_FUNCTIONS } from '../../data/builtins/index.js';

/**
 * Resolution type for a CALL node
 */
type ResolutionType = 'internal' | 'external' | 'builtin' | 'method' | 'unresolved';

/**
 * Call node with optional attributes
 */
interface CallNode extends BaseNodeRecord {
  object?: string; // If present, this is a method call
}

/**
 * Validation summary showing resolution breakdown
 */
interface ValidationSummary {
  totalCalls: number;
  resolvedInternal: number;   // CALLS -> FUNCTION
  resolvedExternal: number;   // CALLS -> EXTERNAL_MODULE
  resolvedBuiltin: number;    // Name in JS_GLOBAL_FUNCTIONS
  methodCalls: number;        // Has 'object' attribute (not validated)
  unresolvedCalls: number;    // No edge, not builtin
  warnings: number;           // = unresolvedCalls
}

export class CallResolverValidator extends Plugin {
  get metadata(): PluginMetadata {
    return {
      name: 'CallResolverValidator',
      phase: 'VALIDATION',
      priority: 90,
      creates: {
        nodes: [],
        edges: []
      },
      dependencies: ['FunctionCallResolver', 'ExternalCallResolver']
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    const { graph } = context;
    const logger = this.log(context);

    logger.info('Starting call resolution validation');

    const warnings: ValidationError[] = [];
    const summary: ValidationSummary = {
      totalCalls: 0,
      resolvedInternal: 0,
      resolvedExternal: 0,
      resolvedBuiltin: 0,
      methodCalls: 0,
      unresolvedCalls: 0,
      warnings: 0
    };

    // Process all CALL nodes
    for await (const node of graph.queryNodes({ nodeType: 'CALL' })) {
      summary.totalCalls++;
      const callNode = node as CallNode;

      const resolutionType = await this.determineResolutionType(graph, callNode);

      switch (resolutionType) {
        case 'internal':
          summary.resolvedInternal++;
          break;
        case 'external':
          summary.resolvedExternal++;
          break;
        case 'builtin':
          summary.resolvedBuiltin++;
          break;
        case 'method':
          summary.methodCalls++;
          break;
        case 'unresolved':
          summary.unresolvedCalls++;
          summary.warnings++;
          warnings.push(this.createWarning(callNode));
          break;
      }
    }

    logger.info('Validation complete', { ...summary });

    if (warnings.length > 0) {
      logger.warn('Unresolved calls detected', { count: warnings.length });
      for (const warning of warnings.slice(0, 10)) {
        logger.warn(warning.message);
      }
      if (warnings.length > 10) {
        logger.debug(`... and ${warnings.length - 10} more`);
      }
    }

    return createSuccessResult(
      { nodes: 0, edges: 0 },
      { summary },
      warnings
    );
  }

  /**
   * Determine the resolution type for a CALL node.
   *
   * Resolution priority:
   * 1. Method call (has 'object' attribute) -> 'method'
   * 2. Has CALLS edge to FUNCTION -> 'internal'
   * 3. Has CALLS edge to EXTERNAL_MODULE -> 'external'
   * 4. Name in JS_GLOBAL_FUNCTIONS -> 'builtin'
   * 5. Otherwise -> 'unresolved'
   */
  private async determineResolutionType(
    graph: PluginContext['graph'],
    callNode: CallNode
  ): Promise<ResolutionType> {
    // 1. Check if method call (has object attribute)
    if (callNode.object) {
      return 'method';
    }

    // 2. Check for CALLS edges
    const edges = await graph.getOutgoingEdges(callNode.id, ['CALLS']);
    if (edges.length > 0) {
      // Determine destination type
      const edge = edges[0];
      const dstNode = await graph.getNode(edge.dst);

      if (dstNode) {
        if (dstNode.type === 'FUNCTION') {
          return 'internal';
        }
        if (dstNode.type === 'EXTERNAL_MODULE') {
          return 'external';
        }
      }

      // Has edge but unknown destination type - treat as resolved
      return 'internal';
    }

    // 3. Check if builtin
    const calledName = callNode.name as string;
    if (calledName && JS_GLOBAL_FUNCTIONS.has(calledName)) {
      return 'builtin';
    }

    // 4. Unresolved
    return 'unresolved';
  }

  /**
   * Create a warning for an unresolved call.
   */
  private createWarning(callNode: CallNode): ValidationError {
    return new ValidationError(
      `Unresolved call to "${callNode.name}" at ${callNode.file}:${callNode.line || '?'}`,
      'WARN_UNRESOLVED_CALL',
      {
        filePath: callNode.file,
        lineNumber: callNode.line as number | undefined,
        phase: 'VALIDATION',
        plugin: 'CallResolverValidator',
        nodeId: callNode.id,
        callName: callNode.name as string,
      },
      'Ensure the function is defined, imported, or is a known global',
      'warning' // Severity: warning (not error)
    );
  }
}
