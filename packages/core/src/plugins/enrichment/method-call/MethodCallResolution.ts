/**
 * MethodCallResolution - Core resolution logic for method calls.
 *
 * Extracted from MethodCallResolver.ts (REG-463).
 * Free functions that resolve method calls to their definitions
 * by searching class indexes, variable types, and inheritance chains.
 */

import type { PluginContext } from '../../Plugin.js';
import type { BaseNodeRecord } from '@grafema/types';
import type { MethodCallNode, ClassEntry } from './MethodCallData.js';

/**
 * Attempts to resolve a method call to its definition.
 *
 * Resolution strategy (in order):
 * 1. Direct class name match (static call)
 * 2. Local class in same file
 * 3. "this" reference to containing class
 * 4. Variable type index (INSTANCE_OF)
 * 5. Interface-aware CHA fallback (REG-485)
 */
export async function resolveMethodCall(
  methodCall: MethodCallNode,
  classMethodIndex: Map<string, ClassEntry>,
  variableTypes: Map<string, string>,
  graph: PluginContext['graph'],
  containingClassCache: Map<string, BaseNodeRecord | null>,
  methodToInterfaces?: Map<string, Set<string>>,
  interfaceImpls?: Map<string, Set<string>>
): Promise<BaseNodeRecord | null> {
  const { object, method, file } = methodCall;

  if (!object || !method) return null;

  // 1. Check if object is a class name directly (static call)
  if (classMethodIndex.has(object)) {
    const classEntry = classMethodIndex.get(object)!;
    if (classEntry.methods.has(method)) {
      return classEntry.methods.get(method)!;
    }
    // REG-400: Check parent classes via DERIVES_FROM chain
    const inherited = await findMethodInParentClasses(
      classEntry.classNode, method, classMethodIndex, graph
    );
    if (inherited) return inherited;
  }

  // 2. Check local class in same file
  const localKey = `${file}:${object}`;
  if (classMethodIndex.has(localKey)) {
    const classEntry = classMethodIndex.get(localKey)!;
    if (classEntry.methods.has(method)) {
      return classEntry.methods.get(method)!;
    }
    // REG-400: Check parent classes via DERIVES_FROM chain
    const inherited = await findMethodInParentClasses(
      classEntry.classNode, method, classMethodIndex, graph
    );
    if (inherited) return inherited;
  }

  // 3. Check if object is "this" (reference to containing class)
  if (object === 'this') {
    let containingClass = containingClassCache.get(methodCall.id);
    if (containingClass === undefined) {
      containingClass = await findContainingClass(methodCall, graph);
      containingClassCache.set(methodCall.id, containingClass);
    }

    if (containingClass && classMethodIndex.has(containingClass.name as string)) {
      const classEntry = classMethodIndex.get(containingClass.name as string)!;
      if (classEntry.methods.has(method)) {
        return classEntry.methods.get(method)!;
      }
      // REG-400: Check parent classes via DERIVES_FROM chain
      const inherited = await findMethodInParentClasses(
        classEntry.classNode, method, classMethodIndex, graph
      );
      if (inherited) return inherited;
    }
  }

  // 4. Use variableTypes index
  for (const [, className] of variableTypes.entries()) {
    if (className && classMethodIndex.has(className)) {
      const classEntry = classMethodIndex.get(className)!;
      if (classEntry.methods.has(method)) {
        return classEntry.methods.get(method)!;
      }
    }
  }

  // 5. Interface-aware CHA fallback (REG-485)
  if (methodToInterfaces && interfaceImpls) {
    const chaResult = await resolveViaInterfaceCHA(
      method, classMethodIndex, methodToInterfaces, interfaceImpls, graph
    );
    if (chaResult) return chaResult;
  }

  return null;
}

/**
 * Step 5: Interface-aware CHA fallback (REG-485).
 *
 * When steps 1-4 fail, look up method name in interface method index,
 * find implementing classes, and resolve to their method definition.
 * Also checks parent classes via DERIVES_FROM for inherited methods.
 * This enables resolution for calls on variables typed as interfaces.
 */
export async function resolveViaInterfaceCHA(
  methodName: string,
  classMethodIndex: Map<string, ClassEntry>,
  methodToInterfaces: Map<string, Set<string>>,
  interfaceImpls: Map<string, Set<string>>,
  graph: PluginContext['graph']
): Promise<BaseNodeRecord | null> {
  const candidateInterfaces = methodToInterfaces.get(methodName);
  if (!candidateInterfaces || candidateInterfaces.size === 0) return null;

  for (const interfaceName of candidateInterfaces) {
    const implementingClasses = interfaceImpls.get(interfaceName);
    if (!implementingClasses) continue;

    for (const className of implementingClasses) {
      const classEntry = classMethodIndex.get(className);
      if (!classEntry) continue;

      if (classEntry.methods.has(methodName)) {
        return classEntry.methods.get(methodName)!;
      }

      // Check parent classes via DERIVES_FROM chain
      const inherited = await findMethodInParentClasses(
        classEntry.classNode, methodName, classMethodIndex, graph
      );
      if (inherited) return inherited;
    }
  }

  return null;
}

/**
 * REG-400: Walk DERIVES_FROM inheritance chain to find inherited methods.
 * Used when method is not found on the direct class.
 */
export async function findMethodInParentClasses(
  classNode: BaseNodeRecord,
  methodName: string,
  classMethodIndex: Map<string, ClassEntry>,
  graph: PluginContext['graph'],
  maxDepth: number = 5,
  visited: Set<string> = new Set()
): Promise<BaseNodeRecord | null> {
  if (maxDepth <= 0) return null;
  if (visited.has(classNode.id.toString())) return null;
  visited.add(classNode.id.toString());

  const derivesFromEdges = await graph.getOutgoingEdges(classNode.id, ['DERIVES_FROM']);

  for (const edge of derivesFromEdges) {
    const parentClass = await graph.getNode(edge.dst);
    if (!parentClass || !parentClass.name) continue;

    const parentEntry = classMethodIndex.get(parentClass.name as string);
    if (parentEntry && parentEntry.methods.has(methodName)) {
      return parentEntry.methods.get(methodName)!;
    }

    // Recurse up the chain
    const found = await findMethodInParentClasses(
      parentClass, methodName, classMethodIndex, graph, maxDepth - 1, visited
    );
    if (found) return found;
  }

  return null;
}

/**
 * Finds the class containing a given method call by traversing CONTAINS edges upward.
 */
export async function findContainingClass(
  methodCall: MethodCallNode,
  graph: PluginContext['graph']
): Promise<BaseNodeRecord | null> {
  const incomingEdges = await graph.getIncomingEdges(methodCall.id, ['CONTAINS']);

  for (const edge of incomingEdges) {
    const parentNode = await graph.getNode(edge.src);
    if (!parentNode) continue;

    if (parentNode.type === 'CLASS') {
      return parentNode;
    }

    const found = await findContainingClassRecursive(parentNode, graph, new Set());
    if (found) return found;
  }

  return null;
}

/**
 * Recursively traverses CONTAINS edges upward to find a CLASS ancestor.
 */
async function findContainingClassRecursive(
  node: BaseNodeRecord,
  graph: PluginContext['graph'],
  visited: Set<string>
): Promise<BaseNodeRecord | null> {
  if (visited.has(node.id.toString())) return null;
  visited.add(node.id.toString());

  const incomingEdges = await graph.getIncomingEdges(node.id, ['CONTAINS']);

  for (const edge of incomingEdges) {
    const parentNode = await graph.getNode(edge.src);
    if (!parentNode) continue;

    if (parentNode.type === 'CLASS') {
      return parentNode;
    }

    const found = await findContainingClassRecursive(parentNode, graph, visited);
    if (found) return found;
  }

  return null;
}
