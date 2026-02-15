/**
 * MethodCallIndexers - Index-building functions for method call resolution.
 *
 * Extracted from MethodCallResolver.ts (REG-463).
 * Free functions that build class-method and variable-type indexes from the graph.
 */

import type { PluginContext } from '../../Plugin.js';
import type { Logger } from '@grafema/types';
import type { ClassEntry } from './MethodCallData.js';

/**
 * Builds an index of classes and their methods for fast lookup.
 * Each class is indexed by name and by file:name for local resolution.
 */
export async function buildClassMethodIndex(
  graph: PluginContext['graph'],
  logger: Logger
): Promise<Map<string, ClassEntry>> {
  const index = new Map<string, ClassEntry>();
  const startTime = Date.now();
  let classCount = 0;

  for await (const classNode of graph.queryNodes({ nodeType: 'CLASS' })) {
    classCount++;
    if (classCount % 50 === 0) {
      logger.debug('Indexing classes', { count: classCount });
    }

    const className = classNode.name as string;
    if (!className) continue;

    const classEntry: ClassEntry = {
      classNode,
      methods: new Map()
    };

    const containsEdges = await graph.getOutgoingEdges(classNode.id, ['CONTAINS']);
    for (const edge of containsEdges) {
      const childNode = await graph.getNode(edge.dst);
      if (childNode && (childNode.type === 'METHOD' || childNode.type === 'FUNCTION')) {
        if (childNode.name) {
          classEntry.methods.set(childNode.name as string, childNode);
        }
      }
    }

    index.set(className, classEntry);

    // Also index by file for local resolution
    const fileKey = `${classNode.file}:${className}`;
    index.set(fileKey, classEntry);
  }

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  logger.debug('Indexed class entries', { count: index.size, time: `${totalTime}s` });

  return index;
}

/**
 * Builds an index of variables and their types (from INSTANCE_OF edges).
 */
export async function buildVariableTypeIndex(
  graph: PluginContext['graph'],
  logger: Logger
): Promise<Map<string, string>> {
  const startTime = Date.now();
  const index = new Map<string, string>();

  for await (const classNode of graph.queryNodes({ nodeType: 'CLASS' })) {
    if (!classNode.name) continue;

    const incomingEdges = await graph.getIncomingEdges(classNode.id, ['INSTANCE_OF']);
    for (const edge of incomingEdges) {
      index.set(edge.src.toString(), classNode.name as string);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  logger.debug('Built variable type index', { entries: index.size, time: `${elapsed}s` });
  return index;
}
