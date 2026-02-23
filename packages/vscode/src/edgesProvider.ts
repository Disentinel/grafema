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
import type { GrafemaClientManager } from './grafemaClient';
import type {
  GraphTreeItem,
  NodeMetadata} from './types';
import {
  parseNodeMetadata,
  formatNodeLabel
} from './types';
import { getNodeIcon } from './utils';

/**
 * Return last 2 path segments for compact display.
 * Example: 'src/auth/login.js' -> 'auth/login.js'
 */
export function formatFilePath(filePath: string): string {
  const parts = filePath.split('/');
  return parts.length <= 2 ? filePath : parts.slice(-2).join('/');
}

export class EdgesProvider implements vscode.TreeDataProvider<GraphTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<GraphTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private rootNode: WireNode | null = null;
  private clientManager: GrafemaClientManager;
  private context: vscode.ExtensionContext | null = null;
  private statusMessage: string | null = null;

  // Navigation history - stack of previous root nodes (for back navigation)
  private rootHistory: WireNode[] = [];
  private static readonly MAX_HISTORY = 20;

  // Navigation path - tracks how we got to current root (for breadcrumb highlighting)
  private navigationPath: Set<string> = new Set();

  // Edge type filter — edge types in this set are hidden from the tree
  private hiddenEdgeTypes: Set<string> = new Set();

  // Bookmarks — persisted via workspaceState
  private bookmarks: WireNode[] = [];
  private static readonly MAX_BOOKMARKS = 20;

  constructor(clientManager: GrafemaClientManager, context?: vscode.ExtensionContext) {
    this.clientManager = clientManager;
    if (context) {
      this.context = context;
      this.loadBookmarks();
    }

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
    if (element.kind === 'bookmark-section') {
      const item = new vscode.TreeItem(
        `Bookmarks (${element.count})`,
        vscode.TreeItemCollapsibleState.Collapsed
      );
      item.iconPath = new vscode.ThemeIcon('bookmark');
      item.contextValue = 'grafemaBookmarkSection';
      return item;
    }

    if (element.kind === 'bookmark') {
      const label = formatNodeLabel(element.node);
      const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
      item.description = formatFilePath(element.node.file);
      item.iconPath = new vscode.ThemeIcon('star-full');
      item.contextValue = 'grafemaBookmark';

      // Click to go to location
      if (element.metadata.line !== undefined) {
        item.command = {
          command: 'grafema.gotoLocation',
          title: 'Go to Location',
          arguments: [element.node.file, element.metadata.line, element.metadata.column ?? 0],
        };
      }

      return item;
    }

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
        item.iconPath = getNodeIcon(element.node.nodeType);
        const filePart = formatFilePath(element.node.file);
        const exportedPart = element.node.exported ? ' exported' : '';
        item.description = `${filePart}${exportedPart}`;
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

    // Root level - return bookmarks section (if any) and the root node
    if (!element) {
      const items: GraphTreeItem[] = [];

      // Prepend bookmark section when bookmarks exist
      if (this.bookmarks.length > 0) {
        items.push({ kind: 'bookmark-section', count: this.bookmarks.length });
      }

      if (this.rootNode) {
        const metadata = parseNodeMetadata(this.rootNode);
        // Start with empty visited set for cycle detection
        // Mark as root so it's expanded by default
        items.push({ kind: 'node', node: this.rootNode, metadata, visitedNodeIds: new Set(), isRoot: true });
      }
      return items;
    }

    // Bookmark section - return bookmark items
    if (element.kind === 'bookmark-section') {
      return this.bookmarks.map((node) => ({
        kind: 'bookmark' as const,
        node,
        metadata: parseNodeMetadata(node),
      }));
    }

    // Bookmark item - not expandable
    if (element.kind === 'bookmark') {
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
        const outgoing = await client.getOutgoingEdges(nodeId);
        await this.buildEdgeItems(client, outgoing, 'outgoing', seenEdges, visitedNodeIds, edges);

        const incoming = await client.getIncomingEdges(nodeId);
        await this.buildEdgeItems(client, incoming, 'incoming', seenEdges, visitedNodeIds, edges);
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
   * Build edge tree items for one direction (outgoing or incoming).
   * Deduplicates by edgeType + targetId + direction, pre-fetches target nodes.
   */
  private async buildEdgeItems(
    client: { getNode(id: string): Promise<WireNode | null> },
    rawEdges: (WireEdge & Record<string, unknown>)[],
    direction: 'outgoing' | 'incoming',
    seenEdges: Set<string>,
    visitedNodeIds: Set<string>,
    out: GraphTreeItem[]
  ): Promise<void> {
    for (const edge of rawEdges) {
      if (!edge.edgeType) continue;
      const targetId = direction === 'outgoing' ? edge.dst : edge.src;
      if (seenEdges.has(targetId)) continue;
      seenEdges.add(targetId);

      if (this.hiddenEdgeTypes.has(edge.edgeType)) continue;
      if (visitedNodeIds.has(targetId)) continue;

      const targetNode = await client.getNode(targetId);
      out.push({
        kind: 'edge',
        edge,
        direction,
        targetNode: targetNode ?? undefined,
        visitedNodeIds,
      });
    }
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
   * Get the current root node (for state export)
   */
  getRootNode(): WireNode | null {
    return this.rootNode;
  }

  /**
   * Get the navigation path as array of node IDs (for state export)
   */
  getNavigationPathIds(): string[] {
    return Array.from(this.navigationPath);
  }

  /**
   * Get history depth (for state export)
   */
  getHistoryDepth(): number {
    return this.rootHistory.length;
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

  // === EDGE TYPE FILTER ===

  /**
   * Get the set of hidden edge types (for UI display)
   */
  getHiddenEdgeTypes(): Set<string> {
    return new Set(this.hiddenEdgeTypes);
  }

  /**
   * Set hidden edge types and refresh tree
   */
  setHiddenEdgeTypes(types: Set<string>): void {
    this.hiddenEdgeTypes = new Set(types);
    this._onDidChangeTreeData.fire();
  }

  // === BOOKMARKS ===

  /**
   * Load bookmarks from workspaceState with safety guard
   */
  private loadBookmarks(): void {
    if (!this.context) return;
    const stored = this.context.workspaceState.get<unknown>('grafema.bookmarks');
    if (Array.isArray(stored)) {
      this.bookmarks = stored.filter(
        (item): item is WireNode => item != null && typeof item === 'object' && typeof (item as WireNode).id === 'string'
      );
    }
  }

  /**
   * Save bookmarks to workspaceState
   */
  private saveBookmarks(): void {
    if (!this.context) return;
    this.context.workspaceState.update('grafema.bookmarks', this.bookmarks);
  }

  /**
   * Add a bookmark (if not already present, cap at MAX_BOOKMARKS)
   */
  addBookmark(node: WireNode): void {
    if (this.bookmarks.some((b) => b.id === node.id)) return;
    this.bookmarks.push(node);
    if (this.bookmarks.length > EdgesProvider.MAX_BOOKMARKS) {
      this.bookmarks.shift();
    }
    this.saveBookmarks();
    this._onDidChangeTreeData.fire();
  }

  /**
   * Remove a bookmark by node id
   */
  removeBookmark(nodeId: string): void {
    this.bookmarks = this.bookmarks.filter((b) => b.id !== nodeId);
    this.saveBookmarks();
    this._onDidChangeTreeData.fire();
  }

  /**
   * Check if a node is bookmarked
   */
  isBookmarked(nodeId: string): boolean {
    return this.bookmarks.some((b) => b.id === nodeId);
  }

  /**
   * Get a copy of current bookmarks
   */
  getBookmarks(): WireNode[] {
    return [...this.bookmarks];
  }

  /**
   * Clear all bookmarks
   */
  clearBookmarks(): void {
    this.bookmarks = [];
    this.saveBookmarks();
    this._onDidChangeTreeData.fire();
  }
}
