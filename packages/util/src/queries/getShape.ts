/**
 * Shape Query Engine
 *
 * Computes the "shape" of a CLASS, INTERFACE, or typed VARIABLE:
 * the set of methods and properties it has, including inherited ones.
 *
 * Shape = { members: ShapeMember[], extends: string[], implementedBy: string[] }
 *
 * For CLASS: own HAS_METHOD + HAS_PROPERTY + walk EXTENDS chain for inherited
 * For INTERFACE: own HAS_METHOD + HAS_PROPERTY (METHOD_SIGNATURE + PROPERTY_SIGNATURE)
 * For VARIABLE: follow INSTANCE_OF → CLASS/INTERFACE → shape
 *
 * @module queries/getShape
 */

export interface ShapeMember {
  name: string;
  kind: 'method' | 'property' | 'method_signature' | 'property_signature';
  from: string;       // CLASS/INTERFACE name that defines this member
  file?: string;
  line?: number;
  nodeId: string;
}

export interface ShapeResult {
  name: string;
  nodeId: string;
  nodeType: string;
  file?: string;
  members: ShapeMember[];
  extends: string[];
  implements: string[];
  implementedBy: string[];
  confidence: 'high' | 'medium' | 'low';
}

interface GraphBackend {
  getNode(id: string): Promise<{
    id: string | number;
    type?: string;
    nodeType?: string;
    name?: string;
    file?: string;
    line?: number;
    metadata?: string | Record<string, unknown>;
    semanticId?: string;
  } | null>;
  getOutgoingEdges(
    nodeId: string,
    edgeTypes?: string[] | null
  ): Promise<Array<{ src: string; dst: string; type: string; metadata?: string }>>;
  getIncomingEdges(
    nodeId: string,
    edgeTypes?: string[] | null
  ): Promise<Array<{ src: string; dst: string; type: string }>>;
}

function nodeType(node: { type?: string; nodeType?: string }): string {
  return node.nodeType ?? node.type ?? 'UNKNOWN';
}

function parseMeta(node: { metadata?: string | Record<string, unknown> }): Record<string, unknown> {
  if (!node.metadata) return {};
  if (typeof node.metadata === 'string') {
    try { return JSON.parse(node.metadata); } catch { return {}; }
  }
  return node.metadata;
}

/** Index mapping class/interface name → node ID for EXTENDS chain walking */
export type ClassIndex = Map<string, string>;

/**
 * Get the shape of a CLASS, INTERFACE, or VARIABLE.
 * @param classIndex — optional name→ID index for resolving EXTENDS/IMPLEMENTS targets
 */
export async function getShape(
  backend: GraphBackend,
  targetId: string,
  classIndex?: ClassIndex,
): Promise<ShapeResult | null> {
  const node = await backend.getNode(targetId);
  if (!node) return null;

  const nType = nodeType(node);
  const nId = String(node.id);

  if (nType === 'CLASS' || nType === 'INTERFACE') {
    return getClassShape(backend, nId, node.name ?? '<unknown>', nType, node.file, classIndex);
  }

  if (nType === 'VARIABLE' || nType === 'CONSTANT' || nType === 'PARAMETER') {
    // Follow INSTANCE_OF to find the class/interface
    const edges = await backend.getOutgoingEdges(nId);
    const instanceOf = edges.find(e => e.type === 'INSTANCE_OF');
    if (!instanceOf) return null;

    const classNode = await backend.getNode(instanceOf.dst);
    if (!classNode) return null;

    const shape = await getClassShape(
      backend,
      String(classNode.id),
      classNode.name ?? '<unknown>',
      nodeType(classNode),
      classNode.file,
      classIndex,
    );
    if (shape) {
      shape.confidence = 'medium'; // inferred, not direct
    }
    return shape;
  }

  return null;
}

/**
 * Get shape for a CLASS or INTERFACE, including inherited members.
 */
async function getClassShape(
  backend: GraphBackend,
  classId: string,
  className: string,
  classType: string,
  classFile?: string,
  classIndex?: ClassIndex,
): Promise<ShapeResult> {
  const members: ShapeMember[] = [];
  const extendsChain: string[] = [];
  const implementsList: string[] = [];
  const implementedBy: string[] = [];
  const visited = new Set<string>();

  // Collect own + inherited members via BFS through EXTENDS
  const queue: Array<{ id: string; name: string }> = [{ id: classId, name: className }];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current.id)) continue;
    visited.add(current.id);

    // Collect HAS_METHOD edges
    const edges = await backend.getOutgoingEdges(current.id);
    for (const edge of edges) {
      if (edge.type === 'HAS_METHOD') {
        const member = await backend.getNode(edge.dst);
        if (member) {
          members.push({
            name: member.name ?? '<unknown>',
            kind: nodeType(member) === 'METHOD_SIGNATURE' ? 'method_signature' : 'method',
            from: current.name,
            file: member.file,
            line: member.line,
            nodeId: String(member.id),
          });
        }
      }
      if (edge.type === 'HAS_PROPERTY') {
        const member = await backend.getNode(edge.dst);
        if (member) {
          const mType = nodeType(member);
          // Skip if it's actually a METHOD_SIGNATURE that was incorrectly HAS_PROPERTY
          // (this handles legacy data before the fix)
          const kind = mType === 'PROPERTY_SIGNATURE' ? 'property_signature'
            : mType === 'METHOD_SIGNATURE' ? 'method_signature'
            : 'property';
          members.push({
            name: member.name ?? '<unknown>',
            kind,
            from: current.name,
            file: member.file,
            line: member.line,
            nodeId: String(member.id),
          });
        }
      }
    }

    // Follow EXTENDS chain
    const meta = await getNodeMeta(backend, current.id);
    const superClass = meta.superClass as string | undefined;
    if (superClass && current.id !== classId) {
      extendsChain.push(superClass);
    } else if (superClass && current.id === classId) {
      extendsChain.push(superClass);
    }
    if (superClass) {
      // Find the superclass node
      const superNode = await findClassByName(backend, superClass, classIndex);
      if (superNode) {
        queue.push({ id: String(superNode.id), name: superNode.name ?? superClass });
      }
    }

    // Collect implements
    const implementsStr = meta.implements as string | undefined;
    if (implementsStr && current.id === classId) {
      implementsList.push(...implementsStr.split(',').map(s => s.trim()).filter(Boolean));
      // Also collect members from implemented interfaces
      for (const ifaceName of implementsList) {
        const ifaceNode = await findClassByName(backend, ifaceName, classIndex);
        if (ifaceNode) {
          queue.push({ id: String(ifaceNode.id), name: ifaceNode.name ?? ifaceName });
        }
      }
    }
  }

  // Find implementedBy (classes that have INSTANCE_OF → this class, or metadata implements)
  // Skip for now — expensive reverse lookup

  return {
    name: className,
    nodeId: classId,
    nodeType: classType,
    file: classFile,
    members,
    extends: extendsChain,
    implements: implementsList,
    implementedBy,
    confidence: 'high',
  };
}

async function getNodeMeta(backend: GraphBackend, nodeId: string): Promise<Record<string, unknown>> {
  const node = await backend.getNode(nodeId);
  if (!node) return {};
  return parseMeta(node);
}

async function findClassByName(
  _backend: GraphBackend,
  name: string,
  classIndex?: ClassIndex,
): Promise<{ id: string; name: string } | null> {
  if (!classIndex) return null;
  const id = classIndex.get(name);
  if (!id) return null;
  return { id, name };
}
