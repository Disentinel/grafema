/**
 * Value Trace Provider — TreeDataProvider for the VALUE TRACE panel.
 *
 * Shows bidirectional value trace: Origins (backward), Destinations (forward),
 * and Connectivity Gaps. Three fixed top-level sections, with recursive
 * trace nodes under each.
 */

import * as vscode from 'vscode';
import type { WireNode } from '@grafema/types';
import type { GrafemaClientManager } from './grafemaClient';
import { traceBackward, traceForward, detectGaps, computeCoverage } from './traceEngine';
import { parseNodeMetadata } from './types';
import { getNodeIcon } from './utils';
import type { ValueTraceItem, TraceNode, TraceResult } from './types';

const PANEL_DEPTH = 5;

export class ValueTraceProvider implements vscode.TreeDataProvider<ValueTraceItem> {
  private _onDidChangeTreeData =
    new vscode.EventEmitter<ValueTraceItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private currentResult: TraceResult | null = null;
  private currentRootNodeId: string | null = null;
  private statusMessage = 'Hover over a variable to trace its value origins.';
  private showDirection: 'backward' | 'forward' | 'both' = 'both';

  constructor(private clientManager: GrafemaClientManager) {
    clientManager.on('reconnected', () => {
      this.currentResult = null;
      this.currentRootNodeId = null;
      this.statusMessage = 'Reconnected \u2014 hover over a variable to trace.';
      this._onDidChangeTreeData.fire();
    });
  }

  /**
   * Trace the given node and update the tree.
   * Caches result: if node.id === currentRootNodeId, skips re-query.
   */
  async traceNode(node: WireNode, maxDepth = PANEL_DEPTH): Promise<void> {
    if (this.currentRootNodeId === node.id && this.currentResult !== null) {
      return;
    }

    if (!this.clientManager.isConnected()) {
      this.statusMessage = 'Not connected to graph.';
      this._onDidChangeTreeData.fire();
      return;
    }

    this.statusMessage = `Tracing "${node.name ?? node.nodeType}"...`;
    this._onDidChangeTreeData.fire();

    try {
      const client = this.clientManager.getClient();

      const [backwardResult, forwardResult] = await Promise.all([
        traceBackward(client, node.id, maxDepth),
        traceForward(client, node.id, maxDepth),
      ]);

      const gaps = detectGaps(backwardResult.nodes);
      const coverage = computeCoverage(backwardResult.nodes);

      this.currentResult = {
        rootNode: node,
        rootMetadata: parseNodeMetadata(node),
        backward: backwardResult.nodes,
        forward: forwardResult.nodes,
        gaps,
        coverage,
        backwardTruncated: backwardResult.truncated,
        forwardTruncated: forwardResult.truncated,
      };
      this.currentRootNodeId = node.id;
      this.statusMessage = '';
      this._onDidChangeTreeData.fire();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.statusMessage = `Error: ${message}`;
      this._onDidChangeTreeData.fire();
    }
  }

  /**
   * Cycle through direction modes: both -> backward -> forward -> both
   */
  cycleDirection(): void {
    const cycle: Array<'backward' | 'forward' | 'both'> = ['both', 'backward', 'forward'];
    const idx = cycle.indexOf(this.showDirection);
    this.showDirection = cycle[(idx + 1) % cycle.length];
    this._onDidChangeTreeData.fire();
  }

  /**
   * Refresh: clear cache so next traceNode re-queries.
   */
  refresh(): void {
    this.currentResult = null;
    this.currentRootNodeId = null;
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: ValueTraceItem): vscode.TreeItem {
    switch (element.kind) {
      case 'status': {
        const item = new vscode.TreeItem(
          element.message,
          vscode.TreeItemCollapsibleState.None
        );
        item.iconPath = new vscode.ThemeIcon('info');
        return item;
      }

      case 'section': {
        const item = new vscode.TreeItem(
          element.label,
          vscode.TreeItemCollapsibleState.Expanded
        );
        item.iconPath = new vscode.ThemeIcon(element.icon);
        item.contextValue = `grafemaTraceSection-${element.direction}`;
        return item;
      }

      case 'trace-node': {
        const tn = element.traceNode;
        const meta = tn.metadata;
        const dirArrow = element.direction === 'backward' ? '\u2190' : '\u2192';
        const nodeName = tn.node.name ?? tn.node.nodeType ?? 'unknown';
        const label = `${dirArrow} ${nodeName}`;

        const hasExpandableChildren = tn.children.length > 0 || tn.hasMoreChildren;
        const item = new vscode.TreeItem(
          label,
          hasExpandableChildren
            ? vscode.TreeItemCollapsibleState.Expanded
            : vscode.TreeItemCollapsibleState.None
        );

        // Description: file:line + annotations
        const file = tn.node.file ?? '';
        const loc = meta.line ? `${file}:${meta.line}` : file;
        const annotations: string[] = [];
        if (tn.sourceKind && tn.sourceKind !== 'unknown') {
          annotations.push(tn.sourceKind.replace('-', ' '));
        }
        item.description = annotations.length > 0
          ? `${loc}  (${annotations.join(', ')})`
          : loc;

        // Standard type-based icon for all trace nodes
        if (tn.sourceKind === 'user-input') {
          item.iconPath = new vscode.ThemeIcon(
            'person',
            new vscode.ThemeColor('charts.orange')
          );
        } else {
          item.iconPath = getNodeIcon(tn.node.nodeType);
        }

        // Click -> go to location
        if (meta.line !== undefined) {
          item.command = {
            command: 'grafema.gotoLocation',
            title: 'Go to Location',
            arguments: [tn.node.file, meta.line, meta.column ?? 0],
          };
        }

        item.tooltip = buildTraceNodeTooltip(tn);
        item.contextValue = 'grafemaTraceNode';
        return item;
      }

      case 'gap': {
        const item = new vscode.TreeItem(
          `Gap: ${element.gap.nodeName}`,
          vscode.TreeItemCollapsibleState.None
        );
        item.description = element.gap.description;
        item.iconPath = new vscode.ThemeIcon(
          'circle-slash',
          new vscode.ThemeColor('editorWarning.foreground')
        );
        item.tooltip = `${element.gap.description}\n\nHeuristic: ${element.gap.heuristic}`;
        item.contextValue = 'grafemaTraceGap';
        return item;
      }

      case 'more': {
        const item = new vscode.TreeItem(
          '5+ more \u2014 open Explorer for full view',
          vscode.TreeItemCollapsibleState.None
        );
        item.iconPath = new vscode.ThemeIcon('ellipsis');
        item.tooltip = 'This node has more origins than shown. Use the Explorer panel or MCP trace_alias for full coverage.';
        return item;
      }

      default:
        return new vscode.TreeItem('Unknown item');
    }
  }

  async getChildren(element?: ValueTraceItem): Promise<ValueTraceItem[]> {
    if (!element) {
      if (!this.currentResult) {
        return [{ kind: 'status', message: this.statusMessage }];
      }

      const items: ValueTraceItem[] = [];

      if (this.showDirection === 'backward' || this.showDirection === 'both') {
        items.push({
          kind: 'section',
          label: `Origins (${this.currentResult.backward.length})`,
          icon: 'arrow-up',
          direction: 'backward',
        });
      }

      if (this.showDirection === 'forward' || this.showDirection === 'both') {
        items.push({
          kind: 'section',
          label: `Destinations (${this.currentResult.forward.length})`,
          icon: 'arrow-down',
          direction: 'forward',
        });
      }

      const { traced, total } = this.currentResult.coverage;
      const gapCount = this.currentResult.gaps.length;
      if (gapCount > 0) {
        items.push({
          kind: 'section',
          label: `Connectivity Gaps (${gapCount}) \u2014 ${traced}/${total} paths traced`,
          icon: 'warning',
          direction: 'gaps',
        });
      } else if (total > 0) {
        items.push({
          kind: 'section',
          label: `Coverage: ${traced}/${total} paths fully traced`,
          icon: 'pass',
          direction: 'gaps',
        });
      }

      return items;
    }

    if (element.kind === 'section') {
      if (!this.currentResult) return [];

      if (element.direction === 'backward') {
        const items: ValueTraceItem[] = this.currentResult.backward.map((tn) => ({
          kind: 'trace-node' as const,
          traceNode: tn,
          direction: 'backward' as const,
        }));
        if (this.currentResult.backwardTruncated) {
          items.push({ kind: 'more', parentNodeId: this.currentResult.rootNode.id, count: -1 });
        }
        return items;
      }

      if (element.direction === 'forward') {
        const items: ValueTraceItem[] = this.currentResult.forward.map((tn) => ({
          kind: 'trace-node' as const,
          traceNode: tn,
          direction: 'forward' as const,
        }));
        if (this.currentResult.forwardTruncated) {
          items.push({ kind: 'more', parentNodeId: this.currentResult.rootNode.id, count: -1 });
        }
        return items;
      }

      if (element.direction === 'gaps') {
        return this.currentResult.gaps.map((gap) => ({
          kind: 'gap' as const,
          gap,
        }));
      }
    }

    if (element.kind === 'trace-node') {
      const tn = element.traceNode;
      const children: ValueTraceItem[] = tn.children.map((child) => ({
        kind: 'trace-node' as const,
        traceNode: child,
        direction: element.direction,
      }));

      if (tn.hasMoreChildren) {
        children.push({
          kind: 'more' as const,
          parentNodeId: tn.node.id,
          count: -1,
        });
      }

      return children;
    }

    return [];
  }

  getParent(_element: ValueTraceItem): null {
    return null;
  }
}

/**
 * Format full tooltip for a trace node.
 */
function buildTraceNodeTooltip(tn: TraceNode): string {
  const lines = [
    `Type: ${tn.node.nodeType}`,
    `Name: ${tn.node.name ?? '(unnamed)'}`,
    `File: ${tn.node.file ?? '(unknown)'}`,
  ];
  if (tn.metadata.line !== undefined) {
    lines.push(`Line: ${tn.metadata.line}`);
  }
  lines.push(`Via: ${tn.edgeType} edge`);
  if (tn.sourceKind) lines.push(`Source kind: ${tn.sourceKind}`);
  return lines.join('\n');
}
