/**
 * GraphConnectivityValidator - проверяет что все узлы связаны с корневыми узлами
 * Находит "островки" - узлы которые не имеют путей до SERVICE/MODULE
 */

import { Plugin, createSuccessResult } from '../Plugin.js';
import type { PluginContext, PluginMetadata, PluginResult } from '../Plugin.js';
import type { NodeRecord } from '@grafema/types';
import { ValidationError } from '../../errors/GrafemaError.js';


/**
 * Unreachable node info for manifest
 */
interface UnreachableNodeInfo {
  id: string;
  type: string;
  name?: string;
}

/**
 * Validation result in manifest
 */
interface ValidationResult {
  unreachableNodes?: UnreachableNodeInfo[];
  hasErrors: boolean;
  totalNodes: number;
  reachableNodes: number;
  unreachableCount?: number;
  unreachableByType?: Record<string, number>;
}

/**
 * Extended manifest with validation field
 */
interface ManifestWithValidation {
  validation?: ValidationResult;
  [key: string]: unknown;
}

export class GraphConnectivityValidator extends Plugin {
  get metadata(): PluginMetadata {
    return {
      name: 'GraphConnectivityValidator',
      phase: 'VALIDATION',
      dependencies: [],
      creates: {
        nodes: [],
        edges: []
      }
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    const { graph, manifest } = context;
    const logger = this.log(context);
    const manifestWithValidation = manifest as ManifestWithValidation;

    logger.info('Starting connectivity validation');

    // Connectivity validation requires the full node set by definition:
    // to find unreachable nodes, we must know all nodes that exist.
    // queryNodes({}) is the streaming equivalent of the removed getAllNodes().
    const allNodes: NodeRecord[] = [];
    for await (const node of graph.queryNodes({})) {
      allNodes.push(node);
    }
    logger.debug('Nodes collected', { totalNodes: allNodes.length });

    // Находим корневые узлы (SERVICE, MODULE)
    const rootTypes = ['SERVICE', 'MODULE', 'PROJECT'];
    const rootNodes = allNodes.filter(n => rootTypes.includes(n.type));
    logger.debug('Root nodes found', { rootCount: rootNodes.length });

    if (rootNodes.length === 0) {
      logger.warn('No root nodes found');
      return createSuccessResult({ nodes: 0, edges: 0 }, { skipped: true, reason: 'No root nodes' });
    }

    // BFS от корневых узлов для поиска достижимых узлов
    const reachable = new Set<string>();
    const queue: string[] = [...rootNodes.map(n => n.id)];

    while (queue.length > 0) {
      const nodeId = queue.shift()!;

      if (reachable.has(nodeId)) continue;
      reachable.add(nodeId);

      // Добавляем все связанные узлы (в обоих направлениях)
      const outgoing = await graph.getOutgoingEdges(nodeId);
      const incoming = await graph.getIncomingEdges(nodeId);

      for (const edge of outgoing) {
        if (!reachable.has(edge.dst)) {
          queue.push(edge.dst);
        }
      }
      for (const edge of incoming) {
        if (!reachable.has(edge.src)) {
          queue.push(edge.src);
        }
      }
    }

    // Находим недостижимые узлы
    const unreachable = allNodes.filter(n => !reachable.has(n.id));
    const errors: ValidationError[] = [];

    if (unreachable.length > 0) {
      const percentage = ((unreachable.length / allNodes.length) * 100).toFixed(1);
      logger.error('GRAPH VALIDATION ERROR: DISCONNECTED NODES FOUND');
      logger.error(`Found ${unreachable.length} unreachable nodes (${percentage}% of total)`);
      logger.error('These nodes are not connected to the main graph (SERVICE/MODULE/PROJECT level)');

      // Группируем по типам для читаемости
      const byType: Record<string, NodeRecord[]> = {};
      for (const node of unreachable) {
        if (!byType[node.type]) byType[node.type] = [];
        byType[node.type].push(node);
      }

      for (const [type, nodes] of Object.entries(byType)) {
        logger.error(`${type}: ${nodes.length} nodes`);
        // Показываем первые 5 для каждого типа
        for (const node of nodes.slice(0, 5)) {
          logger.debug(`  - ${node.name || node.id}`);

          // Показываем связи этого узла
          const out = await graph.getOutgoingEdges(node.id);
          const inc = await graph.getIncomingEdges(node.id);
          if (out.length > 0 || inc.length > 0) {
            logger.debug(`    Edges: ${inc.length} incoming, ${out.length} outgoing`);
          }
        }
        if (nodes.length > 5) {
          logger.debug(`  ... and ${nodes.length - 5} more`);
        }
      }

      logger.error('ACTION REQUIRED: Fix analysis plugins to ensure all nodes are connected');
      logger.error('Anonymous functions, callbacks, and method calls should be linked to parent nodes');

      // Сохраняем информацию в manifest для дальнейшего использования
      if (!manifestWithValidation.validation) manifestWithValidation.validation = {} as ValidationResult;
      manifestWithValidation.validation.unreachableNodes = unreachable.map(n => ({
        id: n.id,
        type: n.type,
        name: n.name
      }));
      manifestWithValidation.validation.hasErrors = true;
      manifestWithValidation.validation.totalNodes = allNodes.length;
      manifestWithValidation.validation.reachableNodes = reachable.size;
      manifestWithValidation.validation.unreachableCount = unreachable.length;
      manifestWithValidation.validation.unreachableByType = Object.fromEntries(
        Object.entries(byType).map(([type, nodes]) => [type, nodes.length])
      );

      // Create summary error for disconnected nodes
      errors.push(new ValidationError(
        `Found ${unreachable.length} unreachable nodes (${percentage}% of total)`,
        'ERR_DISCONNECTED_NODES',
        {
          phase: 'VALIDATION',
          plugin: 'GraphConnectivityValidator',
          totalNodes: allNodes.length,
          reachableNodes: reachable.size,
          unreachableCount: unreachable.length,
          unreachableByType: Object.fromEntries(
            Object.entries(byType).map(([type, nodes]) => [type, nodes.length])
          ),
        },
        'Fix analysis plugins to ensure all nodes are connected'
      ));

      // Create individual errors for each disconnected node (limit to 50)
      const maxIndividualErrors = 50;
      for (const node of unreachable.slice(0, maxIndividualErrors)) {
        errors.push(new ValidationError(
          `Node "${node.name || node.id}" (type: ${node.type}) is not connected to the main graph`,
          'ERR_DISCONNECTED_NODE',
          {
            filePath: node.file,
            lineNumber: node.line as number | undefined,
            phase: 'VALIDATION',
            plugin: 'GraphConnectivityValidator',
            nodeId: node.id,
            nodeType: node.type,
            nodeName: node.name,
          }
        ));
      }
    } else {
      logger.info('All nodes are reachable from root nodes');
      if (!manifestWithValidation.validation) manifestWithValidation.validation = {} as ValidationResult;
      manifestWithValidation.validation.hasErrors = false;
      manifestWithValidation.validation.totalNodes = allNodes.length;
      manifestWithValidation.validation.reachableNodes = reachable.size;
    }

    logger.info('Validation complete', { reachable: reachable.size, total: allNodes.length });

    return createSuccessResult(
      { nodes: 0, edges: 0 },
      { totalNodes: allNodes.length, reachableNodes: reachable.size },
      errors
    );
  }
}
