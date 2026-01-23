/**
 * GraphConnectivityValidator - проверяет что все узлы связаны с корневыми узлами
 * Находит "островки" - узлы которые не имеют путей до SERVICE/MODULE
 */

import { Plugin, createSuccessResult } from '../Plugin.js';
import type { PluginContext, PluginMetadata, PluginResult } from '../Plugin.js';
import type { NodeRecord } from '@grafema/types';

/**
 * Edge structure
 */
interface EdgeRecord {
  src: string;
  dst: string;
  [key: string]: unknown;
}

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
      priority: 100,
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

    // Получаем все узлы
    const allNodes = await graph.getAllNodes();
    logger.debug('Nodes collected', { totalNodes: allNodes.length });

    // Находим корневые узлы (SERVICE, MODULE)
    const rootTypes = ['SERVICE', 'MODULE', 'PROJECT'];
    const rootNodes = allNodes.filter(n => rootTypes.includes(n.type));
    logger.debug('Root nodes found', { rootCount: rootNodes.length });

    if (rootNodes.length === 0) {
      logger.warn('No root nodes found');
      return createSuccessResult({ nodes: 0, edges: 0 }, { skipped: true, reason: 'No root nodes' });
    }

    // Check if graph supports getAllEdges
    if (!graph.getAllEdges) {
      logger.debug('Graph does not support getAllEdges, skipping validation');
      return createSuccessResult({ nodes: 0, edges: 0 }, { skipped: true, reason: 'No getAllEdges support' });
    }

    // Собираем все ребра
    const allEdges = await graph.getAllEdges();
    logger.debug('Edges collected', { totalEdges: allEdges.length });

    // Строим карты смежности (обе направления)
    const adjacencyOut = new Map<string, string[]>(); // nodeId -> [targetIds]
    const adjacencyIn = new Map<string, string[]>();  // nodeId -> [sourceIds]

    for (const edge of allEdges) {
      // Outgoing edges
      if (!adjacencyOut.has(edge.src)) {
        adjacencyOut.set(edge.src, []);
      }
      adjacencyOut.get(edge.src)!.push(edge.dst);

      // Incoming edges
      if (!adjacencyIn.has(edge.dst)) {
        adjacencyIn.set(edge.dst, []);
      }
      adjacencyIn.get(edge.dst)!.push(edge.src);
    }

    // BFS от корневых узлов для поиска достижимых узлов
    const reachable = new Set<string>();
    const queue: string[] = [...rootNodes.map(n => n.id)];

    while (queue.length > 0) {
      const nodeId = queue.shift()!;

      if (reachable.has(nodeId)) continue;
      reachable.add(nodeId);

      // Добавляем все связанные узлы (в обоих направлениях)
      const outgoing = adjacencyOut.get(nodeId) || [];
      const incoming = adjacencyIn.get(nodeId) || [];

      for (const targetId of [...outgoing, ...incoming]) {
        if (!reachable.has(targetId)) {
          queue.push(targetId);
        }
      }
    }

    // Находим недостижимые узлы
    const unreachable = allNodes.filter(n => !reachable.has(n.id));

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
          const out = adjacencyOut.get(node.id) || [];
          const incoming = adjacencyIn.get(node.id) || [];
          if (out.length > 0 || incoming.length > 0) {
            logger.debug(`    Edges: ${incoming.length} incoming, ${out.length} outgoing`);
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
      { totalNodes: allNodes.length, reachableNodes: reachable.size }
    );
  }
}
