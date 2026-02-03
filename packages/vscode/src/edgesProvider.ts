/**
 * Edges Provider - TreeDataProvider for Grafema graph exploration
 *
 * Provides a recursive tree structure:
 * - Root = node at cursor
 * - Children of node = its edges (incoming + outgoing)
 * - Children of edge = target node (which itself is expandable)
 */

import * as vscode from 'vscode';
import type { WireNode, WireEdge } from '@grafema/types';
import { GrafemaClientManager } from './grafemaClient';
import {
  GraphTreeItem,
  parseNodeMetadata,
  formatNodeLabel,
  formatEdgeLabel,
  NodeMetadata,
} from './types';

export class EdgesProvider implements vscode.TreeDataProvider<GraphTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<GraphTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private rootNode: WireNode | null = null;
  private clientManager: GrafemaClientManager;
  private statusMessage: string | null = null;

  // Navigation history - stack of previous root nodes (for back navigation)
  private rootHistory: WireNode[] = [];
  private static readonly MAX_HISTORY = 20;

  // Navigation path - tracks how we got to current root (for breadcrumb highlighting)
  private navigationPath: Set<string> = new Set();

  constructor(clientManager: GrafemaClientManager) {
    this.clientManager = clientManager;

    // Listen for connection state changes
    clientManager.on('stateChange', () => {
      this.refresh();
    });
  }

  /**
   * Set the root node and refresh the tree (clears navigation path)
   * Saves previous root to history for back navigation
   */
  setRootNode(node: WireNode | null): void {
    // Save current root to history (if different from new one)
    if (this.rootNode && node && this.rootNode.id !== node.id) {
      this.rootHistory.push(this.rootNode);
      // Limit history size
      if (this.rootHistory.length > EdgesProvider.MAX_HISTORY) {
        this.rootHistory.shift();
      }
    }
    this.rootNode = node;
    this.statusMessage = null;
    this.navigationPath.clear();
    this._onDidChangeTreeData.fire();
  }

  /**
   * Navigate to a node, keeping breadcrumb trail
   */
  navigateToNode(node: WireNode): void {
    if (this.rootNode) {
      this.navigationPath.add(this.rootNode.id);
    }
    this.rootNode = node;
    this.statusMessage = null;
    this._onDidChangeTreeData.fire();
  }

  /**
   * Check if can go back in history
   */
  canGoBack(): boolean {
    return this.rootHistory.length > 0;
  }

  /**
   * Go back to previous root node
   */
  goBack(): boolean {
    if (this.rootHistory.length === 0) {
      return false;
    }
    const previousRoot = this.rootHistory.pop()!;
    this.rootNode = previousRoot;
    this.statusMessage = null;
    this.navigationPath.clear();
    this._onDidChangeTreeData.fire();
    return true;
  }

  /**
   * Get history length (for UI display)
   */
  getHistoryLength(): number {
    return this.rootHistory.length;
  }

  /**
   * Check if a node is on the navigation path
   */
  isOnPath(nodeId: string): boolean {
    return this.navigationPath.has(nodeId);
  }

  /**
   * Clear navigation and set fresh root (keeps history for back navigation)
   */
  clearAndSetRoot(node: WireNode | null): void {
    // Save current root to history (if different from new one)
    if (this.rootNode && node && this.rootNode.id !== node.id) {
      this.rootHistory.push(this.rootNode);
      if (this.rootHistory.length > EdgesProvider.MAX_HISTORY) {
        this.rootHistory.shift();
      }
    }
    this.navigationPath.clear();
    this.rootNode = node;
    this.statusMessage = null;
    this._onDidChangeTreeData.fire();
  }

  /**
   * Clear all history
   */
  clearHistory(): void {
    this.rootHistory = [];
  }

  /**
   * Set a status message to display (e.g., "No node at cursor")
   */
  setStatusMessage(message: string): void {
    this.rootNode = null;
    this.statusMessage = message;
    this._onDidChangeTreeData.fire();
  }

  /**
   * Refresh the tree
   */
  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  /**
   * Get tree item for display
   */
  getTreeItem(element: GraphTreeItem): vscode.TreeItem {
    if (element.kind === 'node') {
      const label = formatNodeLabel(element.node);
      // Root node is expanded by default, others are collapsed
      const collapsibleState = element.isRoot
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed;
      const item = new vscode.TreeItem(label, collapsibleState);

      item.tooltip = this.formatNodeTooltip(element.node, element.metadata);
      item.contextValue = 'grafemaNode';

      // Highlight nodes on the navigation path
      const isOnPath = element.isOnPath || this.isOnPath(element.node.id);
      if (isOnPath) {
        item.iconPath = new vscode.ThemeIcon('debug-stackframe', new vscode.ThemeColor('testing.iconPassed'));
        item.description = '← path';
      } else {
        item.iconPath = this.getNodeIcon(element.node.nodeType);
      }

      // Command to go to location on click
      if (element.metadata.line !== undefined) {
        item.command = {
          command: 'grafema.gotoLocation',
          title: 'Go to Location',
          arguments: [element.node.file, element.metadata.line, element.metadata.column ?? 0],
        };
      }

      return item;
    } else {
      // Edge item
      const edge = element.edge;
      const direction = element.direction;
      const targetId = direction === 'outgoing' ? edge.dst : edge.src;
      const targetNode = element.targetNode;
      const visitedNodeIds = element.visitedNodeIds ?? new Set();

      // Check if this edge leads to a node on the path
      const isOnPath = element.isOnPath || this.isOnPath(targetId);

      // Check if this edge leads to an already visited node (cycle)
      const isCycle = visitedNodeIds.has(targetId);

      // Show target node info if available
      // Format: "EDGE_TYPE → NODE_TYPE "name"" (horizontal arrow in text)
      // Icon shows direction: ↓ outgoing = down to details, ↑ incoming = up to module
      const targetLabel = targetNode
        ? `${targetNode.nodeType} "${targetNode.name}"`
        : '(unresolved)';
      const label = `${edge.edgeType} \u2192 ${targetLabel}`;

      // If cycle detected, don't allow expansion (None instead of Collapsed)
      const collapsibleState = isCycle
        ? vscode.TreeItemCollapsibleState.None
        : vscode.TreeItemCollapsibleState.Collapsed;

      const item = new vscode.TreeItem(label, collapsibleState);

      item.tooltip = targetNode
        ? `${edge.edgeType}\n${direction === 'outgoing' ? 'To' : 'From'}: ${targetNode.nodeType} "${targetNode.name}"\nFile: ${targetNode.file}${isCycle ? '\n\n⟳ Cycle detected (already visited)' : ''}`
        : `${edge.edgeType}\nTarget node not found in graph`;
      item.contextValue = 'grafemaEdge';

      // Visual indication for cycles
      if (isCycle) {
        item.iconPath = new vscode.ThemeIcon('sync', new vscode.ThemeColor('editorWarning.foreground'));
        item.description = '⟳ cycle';
      } else if (isOnPath) {
        // Highlight edges leading to nodes on path
        // ↓ outgoing = down to details, ↑ incoming = up to module
        item.iconPath = new vscode.ThemeIcon(direction === 'outgoing' ? 'arrow-down' : 'arrow-up', new vscode.ThemeColor('testing.iconPassed'));
        item.description = '← path';
      } else {
        item.iconPath = new vscode.ThemeIcon(direction === 'outgoing' ? 'arrow-down' : 'arrow-up');
      }

      return item;
    }
  }

  /**
   * Get children of a tree item
   */
  async getChildren(element?: GraphTreeItem): Promise<GraphTreeItem[]> {
    // Check connection state first
    const state = this.clientManager.state;

    if (state.status === 'no-database') {
      if (!element) {
        // Return a single item showing the message
        return [];
      }
      return [];
    }

    if (state.status === 'starting-server') {
      return [];
    }

    if (state.status === 'connecting') {
      return [];
    }

    if (state.status === 'error') {
      return [];
    }

    if (state.status !== 'connected') {
      return [];
    }

    // Root level - return the root node
    if (!element) {
      if (this.rootNode) {
        const metadata = parseNodeMetadata(this.rootNode);
        // Start with empty visited set for cycle detection
        // Mark as root so it's expanded by default
        return [{ kind: 'node', node: this.rootNode, metadata, visitedNodeIds: new Set(), isRoot: true }];
      }
      return [];
    }

    const client = this.clientManager.getClient();

    // Node element - return its edges
    if (element.kind === 'node') {
      const nodeId = element.node.id;
      const edges: GraphTreeItem[] = [];
      const seenEdges = new Set<string>(); // For deduplication

      // Track this node as visited for cycle detection
      const visitedNodeIds = new Set(element.visitedNodeIds);
      visitedNodeIds.add(nodeId);

      try {
        // Get outgoing edges
        const outgoing = await client.getOutgoingEdges(nodeId);
        for (const edge of outgoing) {
          // Deduplicate by edgeType + targetId + direction
          const edgeKey = `outgoing:${edge.edgeType}:${edge.dst}`;
          if (seenEdges.has(edgeKey)) {
            continue;
          }
          seenEdges.add(edgeKey);

          // Pre-fetch target node for better labels
          const targetNode = await client.getNode(edge.dst);
          edges.push({
            kind: 'edge',
            edge,
            direction: 'outgoing',
            targetNode: targetNode ?? undefined,
            visitedNodeIds,
          });
        }

        // Get incoming edges
        const incoming = await client.getIncomingEdges(nodeId);
        for (const edge of incoming) {
          // Deduplicate by edgeType + targetId + direction
          const edgeKey = `incoming:${edge.edgeType}:${edge.src}`;
          if (seenEdges.has(edgeKey)) {
            continue;
          }
          seenEdges.add(edgeKey);

          // Pre-fetch source node for better labels
          const targetNode = await client.getNode(edge.src);
          edges.push({
            kind: 'edge',
            edge,
            direction: 'incoming',
            targetNode: targetNode ?? undefined,
            visitedNodeIds,
          });
        }
      } catch (err) {
        console.error('[grafema-explore] Error fetching edges:', err);
        this.setStatusMessage('Error fetching edges');
      }

      return edges;
    }

    // Edge element - return target node
    if (element.kind === 'edge') {
      const targetId = element.direction === 'outgoing' ? element.edge.dst : element.edge.src;
      const visitedNodeIds = element.visitedNodeIds ?? new Set();

      // Cycle detection: if target node is already visited, don't expand
      if (visitedNodeIds.has(targetId)) {
        // Return empty - prevents infinite recursion
        // The edge item itself shows the target info, just can't expand further
        return [];
      }

      try {
        const targetNode = await client.getNode(targetId);
        if (targetNode) {
          const metadata = parseNodeMetadata(targetNode);
          return [{ kind: 'node', node: targetNode, metadata, visitedNodeIds }];
        }
      } catch (err) {
        console.error('[grafema-explore] Error fetching target node:', err);
        this.setStatusMessage('Error fetching node');
      }

      return [];
    }

    return [];
  }

  /**
   * Get parent (for reveal functionality)
   */
  getParent(_element: GraphTreeItem): vscode.ProviderResult<GraphTreeItem> {
    // Not implementing parent navigation for now
    return null;
  }

  /**
   * Format tooltip for a node
   */
  private formatNodeTooltip(node: WireNode, metadata: NodeMetadata): string {
    const lines = [
      `Type: ${node.nodeType}`,
      `Name: ${node.name}`,
      `File: ${node.file}`,
    ];

    if (metadata.line !== undefined) {
      lines.push(`Line: ${metadata.line}`);
    }

    if (node.exported) {
      lines.push('Exported: yes');
    }

    return lines.join('\n');
  }

  /**
   * Get icon for a node type
   */
  private getNodeIcon(nodeType: string): vscode.ThemeIcon {
    // Map node types to VS Code icons
    const iconMap: Record<string, string> = {
      FUNCTION: 'symbol-function',
      METHOD: 'symbol-method',
      CLASS: 'symbol-class',
      VARIABLE: 'symbol-variable',
      PARAMETER: 'symbol-parameter',
      CONSTANT: 'symbol-constant',
      MODULE: 'symbol-module',
      IMPORT: 'package',
      EXPORT: 'export',
      CALL: 'call-outgoing',
      FILE: 'file-code',
      SCOPE: 'bracket',
      BRANCH: 'git-branch',
      LOOP: 'sync',
      LITERAL: 'symbol-string',
      EXPRESSION: 'symbol-operator',
    };

    const iconName = iconMap[nodeType] || 'symbol-misc';
    return new vscode.ThemeIcon(iconName);
  }

  /**
   * Get the current status message for display
   */
  getStatusMessage(): string | null {
    const state = this.clientManager.state;

    if (state.status === 'no-database') {
      return state.message;
    }

    if (state.status === 'starting-server') {
      return 'Starting graph server...';
    }

    if (state.status === 'connecting') {
      return 'Connecting...';
    }

    if (state.status === 'error') {
      return `Error: ${state.message}`;
    }

    if (this.statusMessage) {
      return this.statusMessage;
    }

    if (!this.rootNode) {
      return 'Click on code to explore the graph';
    }

    return null;
  }
}
