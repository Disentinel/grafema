/**
 * Callers Provider -- TreeDataProvider for the CALLERS panel.
 *
 * Shows call hierarchy: Incoming callers and Outgoing callees
 * for the function at cursor. Lazy per-node loading with
 * cycle detection and configurable depth/filters.
 */

import * as vscode from 'vscode';
import type { WireNode } from '@grafema/types';
import type { GrafemaClientManager } from './grafemaClient';
import { parseNodeMetadata } from './types';
import type { CallersItem, NodeMetadata } from './types';
import { getNodeIcon } from './utils';
import { MAX_BRANCHING_FACTOR } from './traceEngine';

/** Edge type used for call hierarchy traversal */
const CALLS_EDGE_TYPES = ['CALLS'] as const;

/** Patterns that identify test files */
const TEST_FILE_PATTERNS = [
  '/test/',
  '/tests/',
  '.test.',
  '.spec.',
  '__tests__',
  '__test__',
  'cypress/',
  'e2e/',
];

/**
 * Check if a file path matches test file patterns.
 */
function isTestFile(filePath: string): boolean {
  return TEST_FILE_PATTERNS.some((pattern) => filePath.includes(pattern));
}

export class CallersProvider implements vscode.TreeDataProvider<CallersItem> {
  private _onDidChangeTreeData =
    new vscode.EventEmitter<CallersItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private rootNode: WireNode | null = null;
  private rootMetadata: NodeMetadata = {};
  private incomingCount = 0;
  private outgoingCount = 0;
  private maxDepth = 3;
  private hideTestFiles = true;
  private hideNodeModules = true;
  private showDirection: 'incoming' | 'outgoing' | 'both' = 'both';

  constructor(private clientManager: GrafemaClientManager) {
    clientManager.on('reconnected', () => {
      this.rootNode = null;
      this.incomingCount = 0;
      this.outgoingCount = 0;
      this._onDidChangeTreeData.fire();
    });

    // Read initial settings
    const config = vscode.workspace.getConfiguration('grafema');
    this.maxDepth = config.get<number>('callers.defaultDepth') ?? 3;
    this.hideTestFiles = config.get<boolean>('callers.hideTestFiles') ?? true;
    this.hideNodeModules = config.get<boolean>('callers.hideNodeModules') ?? true;
  }

  /**
   * Set root node and refresh the tree. Async-fetches counts for section headers.
   */
  setRootNode(node: WireNode | null): void {
    if (node && this.rootNode && node.id === this.rootNode.id) {
      return; // same node, skip
    }
    this.rootNode = node;
    this.rootMetadata = node ? parseNodeMetadata(node) : {};
    this.incomingCount = 0;
    this.outgoingCount = 0;
    this._onDidChangeTreeData.fire();

    if (node && this.clientManager.isConnected()) {
      this.fetchCounts(node.id);
    }
  }

  /**
   * Fetch caller/callee counts and update section headers.
   */
  private async fetchCounts(nodeId: string): Promise<void> {
    try {
      const client = this.clientManager.getClient();
      const [incoming, outgoing] = await Promise.all([
        client.getIncomingEdges(nodeId, [...CALLS_EDGE_TYPES]),
        client.getOutgoingEdges(nodeId, [...CALLS_EDGE_TYPES]),
      ]);
      // Only update if root has not changed while fetching
      if (this.rootNode && this.rootNode.id === nodeId) {
        this.incomingCount = incoming.length;
        this.outgoingCount = outgoing.length;
        this._onDidChangeTreeData.fire();
      }
    } catch {
      // Silent fail -- counts stay at 0
    }
  }

  getMaxDepth(): number {
    return this.maxDepth;
  }

  setMaxDepth(depth: number): void {
    this.maxDepth = Math.max(1, Math.min(5, depth));
    this._onDidChangeTreeData.fire();
  }

  getHideTestFiles(): boolean {
    return this.hideTestFiles;
  }

  setHideTestFiles(value: boolean): void {
    this.hideTestFiles = value;
    this._onDidChangeTreeData.fire();
  }

  getHideNodeModules(): boolean {
    return this.hideNodeModules;
  }

  setHideNodeModules(value: boolean): void {
    this.hideNodeModules = value;
    this._onDidChangeTreeData.fire();
  }

  setDirection(direction: 'incoming' | 'outgoing' | 'both'): void {
    this.showDirection = direction;
    this._onDidChangeTreeData.fire();
  }

  /**
   * Cycle through direction modes: both -> incoming -> outgoing -> both
   */
  cycleDirection(): void {
    const cycle: Array<'both' | 'incoming' | 'outgoing'> = ['both', 'incoming', 'outgoing'];
    const idx = cycle.indexOf(this.showDirection);
    this.showDirection = cycle[(idx + 1) % cycle.length];
    this._onDidChangeTreeData.fire();
  }

  /**
   * Clear root and re-fetch.
   */
  refresh(): void {
    const node = this.rootNode;
    this.rootNode = null;
    this.incomingCount = 0;
    this.outgoingCount = 0;
    this._onDidChangeTreeData.fire();

    if (node) {
      // Re-set root to trigger fresh counts
      this.rootNode = node;
      this.rootMetadata = parseNodeMetadata(node);
      this._onDidChangeTreeData.fire();
      if (this.clientManager.isConnected()) {
        this.fetchCounts(node.id);
      }
    }
  }

  getTreeItem(element: CallersItem): vscode.TreeItem {
    switch (element.kind) {
      case 'root': {
        const label = `${element.node.nodeType} "${element.node.name}"`;
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
        item.iconPath = getNodeIcon(element.node.nodeType);
        item.contextValue = 'grafemaCallersRoot';

        if (element.metadata.line !== undefined) {
          item.command = {
            command: 'grafema.gotoLocation',
            title: 'Go to Location',
            arguments: [element.node.file, element.metadata.line, element.metadata.column ?? 0],
          };
        }

        const file = element.node.file ?? '';
        const loc = element.metadata.line ? `${file}:${element.metadata.line}` : file;
        item.description = loc;
        item.tooltip = buildCallersTooltip(element.node, element.metadata);
        return item;
      }

      case 'section': {
        const item = new vscode.TreeItem(
          element.label,
          vscode.TreeItemCollapsibleState.Expanded
        );
        item.iconPath = new vscode.ThemeIcon(element.icon);
        item.contextValue = `grafemaCallersSection-${element.direction}`;
        return item;
      }

      case 'call-node': {
        const meta = element.metadata;
        const dirArrow = element.direction === 'incoming' ? '\u2190' : '\u2192';
        const nodeName = element.node.name ?? element.node.nodeType ?? 'unknown';
        const label = `${dirArrow} ${nodeName}`;

        const item = new vscode.TreeItem(
          label,
          element.depth + 1 >= this.maxDepth
            ? vscode.TreeItemCollapsibleState.None
            : vscode.TreeItemCollapsibleState.Collapsed
        );

        const file = element.node.file ?? '';
        const loc = meta.line ? `${file}:${meta.line}` : file;
        item.description = loc;
        item.iconPath = getNodeIcon(element.node.nodeType);
        item.tooltip = buildCallersTooltip(element.node, meta);
        item.contextValue = 'grafemaCallersNode';

        if (meta.line !== undefined) {
          item.command = {
            command: 'grafema.gotoLocation',
            title: 'Go to Location',
            arguments: [element.node.file, meta.line, meta.column ?? 0],
          };
        }

        return item;
      }

      case 'status': {
        const item = new vscode.TreeItem(
          element.message,
          vscode.TreeItemCollapsibleState.None
        );
        item.iconPath = new vscode.ThemeIcon('info');
        return item;
      }

      case 'more': {
        const item = new vscode.TreeItem(
          `${element.count}+ more`,
          vscode.TreeItemCollapsibleState.None
        );
        item.iconPath = new vscode.ThemeIcon('ellipsis');
        item.tooltip = 'This node has more callers/callees than shown. Use the Explorer panel for the full call graph.';
        return item;
      }

      default:
        return new vscode.TreeItem('Unknown item');
    }
  }

  async getChildren(element?: CallersItem): Promise<CallersItem[]> {
    // Root level
    if (!element) {
      if (!this.clientManager.isConnected()) {
        return [{ kind: 'status', message: 'Not connected to graph.' }];
      }
      if (!this.rootNode) {
        return [{ kind: 'status', message: 'Move cursor to a function to see its callers.' }];
      }

      const items: CallersItem[] = [];
      items.push({ kind: 'root', node: this.rootNode, metadata: this.rootMetadata });

      if (this.showDirection !== 'outgoing') {
        items.push({
          kind: 'section',
          label: `Incoming (${this.incomingCount} callers)`,
          icon: 'call-incoming',
          direction: 'incoming',
          count: this.incomingCount,
        });
      }

      if (this.showDirection !== 'incoming') {
        items.push({
          kind: 'section',
          label: `Outgoing (${this.outgoingCount} callees)`,
          icon: 'call-outgoing',
          direction: 'outgoing',
          count: this.outgoingCount,
        });
      }

      return items;
    }

    // Section: fetch edges for the root node
    if (element.kind === 'section') {
      return this.fetchCallNodes(element.direction, this.rootNode, new Set());
    }

    // call-node: recursively expand
    if (element.kind === 'call-node') {
      if (element.depth + 1 >= this.maxDepth) {
        return [];
      }
      return this.fetchCallNodes(element.direction, element.node, element.visitedIds);
    }

    // root, status, more: no children
    return [];
  }

  /**
   * Fetch call nodes for a given parent. Applies filters, caps at MAX_BRANCHING_FACTOR,
   * and detects cycles via visitedIds.
   */
  private async fetchCallNodes(
    direction: 'incoming' | 'outgoing',
    parentNode: WireNode | null,
    parentVisitedIds: Set<string>
  ): Promise<CallersItem[]> {
    if (!parentNode || !this.clientManager.isConnected()) {
      return [];
    }

    try {
      const client = this.clientManager.getClient();
      const edges = direction === 'incoming'
        ? await client.getIncomingEdges(parentNode.id, [...CALLS_EDGE_TYPES])
        : await client.getOutgoingEdges(parentNode.id, [...CALLS_EDGE_TYPES]);

      const newVisited = new Set(parentVisitedIds);
      newVisited.add(parentNode.id);

      const depth = parentVisitedIds.size; // depth = number of ancestors visited
      const children: CallersItem[] = [];
      let skipped = 0;

      for (const edge of edges) {
        if (children.length >= MAX_BRANCHING_FACTOR) {
          break;
        }

        const peerId = direction === 'incoming' ? edge.src : edge.dst;

        // Cycle detection
        if (newVisited.has(peerId)) {
          skipped++;
          continue;
        }

        const peerNode = await client.getNode(peerId);
        if (!peerNode) {
          skipped++;
          continue;
        }

        // Apply filters
        const peerFile = peerNode.file ?? '';
        if (this.hideTestFiles && isTestFile(peerFile)) {
          skipped++;
          continue;
        }
        if (this.hideNodeModules && peerFile.includes('node_modules/')) {
          skipped++;
          continue;
        }

        children.push({
          kind: 'call-node',
          node: peerNode,
          metadata: parseNodeMetadata(peerNode),
          direction,
          depth,
          visitedIds: newVisited,
        });
      }

      // Remaining unprocessed edges (upper bound — may include cycles/filtered)
      const processed = children.length + skipped;
      const remaining = edges.length - processed;
      if (remaining > 0) {
        children.push({ kind: 'more', count: remaining });
      }

      return children;
    } catch {
      // Silent fail on network errors during expansion
      return [];
    }
  }

  getParent(_element: CallersItem): null {
    return null;
  }
}

/**
 * Build tooltip for a caller/callee node.
 */
function buildCallersTooltip(node: WireNode, metadata: NodeMetadata): string {
  const lines = [
    `Type: ${node.nodeType}`,
    `Name: ${node.name ?? '(unnamed)'}`,
    `File: ${node.file ?? '(unknown)'}`,
  ];
  if (metadata.line !== undefined) {
    lines.push(`Line: ${metadata.line}`);
  }
  if (node.exported) {
    lines.push('Exported: yes');
  }
  return lines.join('\n');
}
