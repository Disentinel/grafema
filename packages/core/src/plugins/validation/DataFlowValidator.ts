import { Plugin, createSuccessResult } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';
import type { NodeRecord } from '@grafema/types';
import { ValidationError } from '../../errors/GrafemaError.js';

interface PathResult {
  found: boolean;
  chain: string[];
}

interface ValidationSummary {
  total: number;
  validated: number;
  issues: number;
  byType: Record<string, number>;
}

export class DataFlowValidator extends Plugin {
  get metadata(): PluginMetadata {
    return {
      name: 'DataFlowValidator',
      phase: 'VALIDATION',
      dependencies: [],
      creates: {
        nodes: [],
        edges: []
      }
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    const { graph, onProgress } = context;
    const logger = this.log(context);

    logger.info('Starting data flow validation');

    const variables: NodeRecord[] = [];
    let collected = 0;
    for await (const node of graph.queryNodes({ nodeType: 'VARIABLE' })) {
      variables.push(node);
      collected++;
      if (onProgress && collected % 500 === 0) {
        onProgress({
          phase: 'validation',
          currentPlugin: 'DataFlowValidator',
          message: `Collecting variables: ${collected}`,
          processedFiles: collected,
        });
      }
    }
    for await (const node of graph.queryNodes({ nodeType: 'CONSTANT' })) {
      variables.push(node);
      collected++;
      if (onProgress && collected % 500 === 0) {
        onProgress({
          phase: 'validation',
          currentPlugin: 'DataFlowValidator',
          message: `Collecting variables: ${collected}`,
          processedFiles: collected,
        });
      }
    }

    logger.debug('Variables collected', { count: variables.length });

    const errors: ValidationError[] = [];
    const leafTypes = new Set([
      'LITERAL',
      'ARRAY_LITERAL',   // REG-570
      'OBJECT_LITERAL',  // REG-570
      'net:stdio',
      'db:query',
      'net:request',
      'fs:operation',
      'event:listener',
      'CLASS',
      'FUNCTION',
      'CALL',
      'CONSTRUCTOR_CALL'
    ]);

    let checked = 0;
    for (const variable of variables) {
      checked++;
      if (onProgress && checked % 200 === 0) {
        onProgress({
          phase: 'validation',
          currentPlugin: 'DataFlowValidator',
          message: `Validating data flow: ${checked}/${variables.length}`,
          totalFiles: variables.length,
          processedFiles: checked,
        });
      }

      const outgoing = await graph.getOutgoingEdges(variable.id, ['ASSIGNED_FROM', 'DERIVES_FROM']);
      const assignment = outgoing[0];

      if (!assignment) {
        // REG-570: Class fields with no initializer are legitimately uninitialized.
        // isClassProperty + no value = TypeScript declaration-only field (e.g., `name: string;`)
        if ((variable as Record<string, unknown>).isClassProperty) {
          continue;
        }
        errors.push(new ValidationError(
          `Variable "${variable.name}" (${variable.file}:${variable.line}) has no ASSIGNED_FROM or DERIVES_FROM edge`,
          'ERR_MISSING_ASSIGNMENT',
          {
            filePath: variable.file,
            lineNumber: variable.line as number | undefined,
            phase: 'VALIDATION',
            plugin: 'DataFlowValidator',
            variable: variable.name as string,
          },
          undefined,
          'warning'
        ));
        continue;
      }

      const source = await graph.getNode(assignment.dst);
      if (!source) {
        errors.push(new ValidationError(
          `Variable "${variable.name}" references non-existent node ${assignment.dst}`,
          'ERR_BROKEN_REFERENCE',
          {
            filePath: variable.file,
            lineNumber: variable.line as number | undefined,
            phase: 'VALIDATION',
            plugin: 'DataFlowValidator',
            variable: variable.name as string,
            targetNodeId: assignment.dst,
          },
          undefined,
          'error'
        ));
        continue;
      }

      const path = await this.findPathToLeaf(variable, graph, leafTypes);
      if (!path.found) {
        errors.push(new ValidationError(
          `Variable "${variable.name}" (${variable.file}:${variable.line}) does not trace to a leaf node. Chain: ${path.chain.join(' -> ')}`,
          'ERR_NO_LEAF_NODE',
          {
            filePath: variable.file,
            lineNumber: variable.line as number | undefined,
            phase: 'VALIDATION',
            plugin: 'DataFlowValidator',
            variable: variable.name as string,
            chain: path.chain,
          },
          undefined,
          'warning'
        ));
      }
    }

    const byCode: Record<string, number> = {};
    for (const error of errors) {
      if (!byCode[error.code]) {
        byCode[error.code] = 0;
      }
      byCode[error.code]++;
    }

    const summary: ValidationSummary = {
      total: variables.length,
      validated: variables.length - errors.length,
      issues: errors.length,
      byType: byCode
    };

    logger.info('Validation complete', { ...summary });

    if (errors.length > 0) {
      logger.warn('Data flow issues found', { count: errors.length });
      for (const error of errors) {
        if (error.severity === 'error') {
          logger.error(`[${error.code}] ${error.message}`);
        } else {
          logger.warn(`[${error.code}] ${error.message}`);
        }
      }
    }

    return createSuccessResult(
      { nodes: 0, edges: 0 },
      { summary },
      errors
    );
  }

  private async findPathToLeaf(
    startNode: NodeRecord,
    graph: PluginContext['graph'],
    leafTypes: Set<string>,
    visited: Set<string> = new Set(),
    chain: string[] = []
  ): Promise<PathResult> {
    if (visited.has(startNode.id)) {
      return { found: false, chain: [...chain, `${startNode.type}:${startNode.name} (CYCLE)`] };
    }

    visited.add(startNode.id);
    chain.push(`${startNode.type}:${startNode.name}`);

    if (leafTypes.has(startNode.type)) {
      return { found: true, chain };
    }

    const incomingUses = await graph.getIncomingEdges(startNode.id, ['USES']);
    const usedByCall = incomingUses[0];
    if (usedByCall) {
      const callNode = await graph.getNode(usedByCall.src);
      const callName = callNode?.name ?? usedByCall.src;
      return { found: true, chain: [...chain, `(used by ${callName})`] };
    }

    const outgoing = await graph.getOutgoingEdges(startNode.id, ['ASSIGNED_FROM', 'DERIVES_FROM']);
    const assignment = outgoing[0];

    if (!assignment) {
      return { found: false, chain: [...chain, '(no assignment)'] };
    }

    const nextNode = await graph.getNode(assignment.dst);
    if (!nextNode) {
      return { found: false, chain: [...chain, '(broken reference)'] };
    }

    return this.findPathToLeaf(nextNode, graph, leafTypes, visited, chain);
  }
}
