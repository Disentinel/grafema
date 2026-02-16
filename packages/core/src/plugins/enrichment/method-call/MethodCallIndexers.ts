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
 * Builds an index of interface methods for CHA-based resolution (REG-485).
 * Maps method name to the set of interface names that declare (or inherit) that method.
 *
 * Algorithm:
 * 1. Query all INTERFACE nodes and extract method names from properties
 * 2. Track EXTENDS edges between interfaces
 * 3. Flatten inherited methods (walk EXTENDS chain with cycle protection, max depth 10)
 * 4. Build final map: method name -> set of interface names
 */
export async function buildInterfaceMethodIndex(
  graph: PluginContext['graph'],
  logger: Logger
): Promise<Map<string, Set<string>>> {
  const startTime = Date.now();
  const index = new Map<string, Set<string>>();

  // Collect direct methods per interface and EXTENDS relationships
  const interfaceMethods = new Map<string, Set<string>>();
  const interfaceExtends = new Map<string, string[]>();

  for await (const node of graph.queryNodes({ nodeType: 'INTERFACE' })) {
    const interfaceName = node.name as string;
    if (!interfaceName) continue;

    // Parse properties field (may be JSON string or already parsed array)
    let properties: Array<{ name: string; type?: string }> = [];
    if (node.properties) {
      try {
        properties = typeof node.properties === 'string'
          ? JSON.parse(node.properties)
          : node.properties as Array<{ name: string; type?: string }>;
      } catch {
        // Skip unparseable properties
      }
    }

    const methods = new Set<string>();
    if (Array.isArray(properties)) {
      for (const prop of properties) {
        if (prop && typeof prop.name === 'string' && prop.name) {
          methods.add(prop.name);
        }
      }
    }
    interfaceMethods.set(interfaceName, methods);

    // Track EXTENDS edges for inheritance flattening
    const extendsEdges = await graph.getOutgoingEdges(node.id, ['EXTENDS']);
    if (extendsEdges.length > 0) {
      const parentNames: string[] = [];
      for (const edge of extendsEdges) {
        const parentNode = await graph.getNode(edge.dst);
        if (parentNode && parentNode.name) {
          parentNames.push(parentNode.name as string);
        }
      }
      if (parentNames.length > 0) {
        interfaceExtends.set(interfaceName, parentNames);
      }
    }
  }

  // Flatten inherited methods with cycle protection
  const resolvedMethods = new Map<string, Set<string>>();

  function collectMethods(name: string, visited: Set<string>, depth: number): Set<string> {
    if (depth > 10 || visited.has(name)) return new Set();
    if (resolvedMethods.has(name)) return resolvedMethods.get(name)!;

    visited.add(name);
    const ownMethods = interfaceMethods.get(name) || new Set<string>();
    const allMethods = new Set(ownMethods);

    const parents = interfaceExtends.get(name);
    if (parents) {
      for (const parent of parents) {
        const parentMethods = collectMethods(parent, visited, depth + 1);
        for (const m of parentMethods) {
          allMethods.add(m);
        }
      }
    }

    resolvedMethods.set(name, allMethods);
    return allMethods;
  }

  for (const name of interfaceMethods.keys()) {
    collectMethods(name, new Set(), 0);
  }

  // Build final index: method name -> set of interface names
  for (const [interfaceName, methods] of resolvedMethods) {
    for (const methodName of methods) {
      let interfaces = index.get(methodName);
      if (!interfaces) {
        interfaces = new Set();
        index.set(methodName, interfaces);
      }
      interfaces.add(interfaceName);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  logger.debug('Built interface method index', {
    interfaces: interfaceMethods.size,
    methods: index.size,
    time: `${elapsed}s`
  });

  return index;
}

/**
 * Builds an index of interface implementations for CHA-based resolution (REG-485).
 * Maps interface name to the set of class names that implement it.
 *
 * Algorithm:
 * 1. Query all CLASS nodes
 * 2. For each class, get outgoing IMPLEMENTS edges
 * 3. For each IMPLEMENTS edge, get the target INTERFACE node name
 * 4. Accumulate: interface name -> Set of class names
 */
export async function buildInterfaceImplementationIndex(
  graph: PluginContext['graph'],
  logger: Logger
): Promise<Map<string, Set<string>>> {
  const startTime = Date.now();
  const index = new Map<string, Set<string>>();

  for await (const classNode of graph.queryNodes({ nodeType: 'CLASS' })) {
    const className = classNode.name as string;
    if (!className) continue;

    const implementsEdges = await graph.getOutgoingEdges(classNode.id, ['IMPLEMENTS']);
    for (const edge of implementsEdges) {
      const interfaceNode = await graph.getNode(edge.dst);
      if (!interfaceNode || !interfaceNode.name) continue;

      const interfaceName = interfaceNode.name as string;
      let classes = index.get(interfaceName);
      if (!classes) {
        classes = new Set();
        index.set(interfaceName, classes);
      }
      classes.add(className);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  logger.debug('Built interface implementation index', {
    interfaces: index.size,
    time: `${elapsed}s`
  });

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
