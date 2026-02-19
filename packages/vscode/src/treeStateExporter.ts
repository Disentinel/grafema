/**
 * Tree State Exporter — debug utility for exporting tree state to clipboard.
 *
 * Extracts tree state information for debugging extension behavior.
 * Used by the grafema.copyTreeState command.
 */

import type { WireNode } from '@grafema/types';
import type { GrafemaClientManager } from './grafemaClient';
import type { EdgesProvider } from './edgesProvider';
import type { GraphTreeItem } from './types';
import { parseNodeMetadata } from './types';

export interface NodeStateInfo {
  id: string;
  type: string;
  name: string;
  file: string;
  line?: number;
}

export interface TreeStateExport {
  connection: string;
  serverVersion: string | null;
  stats: { nodes: number; edges: number } | null;
  rootNode: NodeStateInfo | null;
  selectedNode: NodeStateInfo | null;
  visibleEdges: Array<{
    direction: 'outgoing' | 'incoming';
    type: string;
    target: string;
  }>;
  navigationPath: string[];
  historyDepth: number;
}

export function nodeToStateInfo(node: WireNode): NodeStateInfo {
  const metadata = parseNodeMetadata(node);
  return {
    id: node.id,
    type: node.nodeType,
    name: node.name,
    file: node.file,
    line: metadata.line,
  };
}

export async function buildTreeState(
  clientManager: GrafemaClientManager,
  edgesProvider: EdgesProvider,
  selectedItem: GraphTreeItem | null
): Promise<TreeStateExport> {
  const state: TreeStateExport = {
    connection: clientManager.state.status,
    serverVersion: null,
    stats: null,
    rootNode: null,
    selectedNode: null,
    visibleEdges: [],
    navigationPath: edgesProvider.getNavigationPathIds(),
    historyDepth: edgesProvider.getHistoryDepth(),
  };

  // Get server info if connected
  if (clientManager.isConnected()) {
    try {
      const client = clientManager.getClient();
      const version = await client.ping();
      state.serverVersion = version || null;

      const [nodeCount, edgeCount] = await Promise.all([
        client.nodeCount(),
        client.edgeCount(),
      ]);
      state.stats = { nodes: nodeCount, edges: edgeCount };
    } catch {
      // Ignore errors - just leave as null
    }
  }

  // Root node info
  const rootNode = edgesProvider.getRootNode();
  if (rootNode) {
    state.rootNode = nodeToStateInfo(rootNode);
  }

  // Selected node info
  const selectedNode = selectedItem?.kind === 'node'
    ? selectedItem.node
    : selectedItem?.kind === 'edge'
      ? selectedItem.targetNode ?? null
      : null;

  if (selectedNode) {
    state.selectedNode = nodeToStateInfo(selectedNode);
  }

  // Fetch visible edges for selected node if connected
  if (selectedItem?.kind === 'node' && clientManager.isConnected()) {
    try {
      const client = clientManager.getClient();
      const [outgoing, incoming] = await Promise.all([
        client.getOutgoingEdges(selectedItem.node.id),
        client.getIncomingEdges(selectedItem.node.id),
      ]);

      for (const edge of outgoing) {
        state.visibleEdges.push({
          direction: 'outgoing',
          type: edge.edgeType,
          target: edge.dst,
        });
      }

      for (const edge of incoming) {
        state.visibleEdges.push({
          direction: 'incoming',
          type: edge.edgeType,
          target: edge.src,
        });
      }
    } catch {
      // Ignore errors
    }
  }

  return state;
}
