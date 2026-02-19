/**
 * Blast Radius Provider -- TreeDataProvider for the BLAST RADIUS panel.
 *
 * Shows impact analysis: which nodes depend on the function at cursor,
 * grouped into direct dependents (1-hop), indirect dependents (2+ hops),
 * and guarantees at risk. Uses Pattern B (createTreeView) for future
 * badge support.
 *
 * BFS computation is delegated to blastRadiusEngine.ts (no VSCode deps).
 * Race conditions from rapid cursor movement are handled via a requestId
 * counter — stale BFS results are discarded.
 */

import * as vscode from 'vscode';
import type { WireNode } from '@grafema/types';
import type { GrafemaClientManager } from './grafemaClient';
import { parseNodeMetadata } from './types';
import type { BlastRadiusItem } from './types';
import type { BlastRadiusResult } from './blastRadiusEngine';
import { computeBlastRadius, DEFAULT_MAX_DEPTH } from './blastRadiusEngine';

export class BlastRadiusProvider implements vscode.TreeDataProvider<BlastRadiusItem> {
  private _onDidChangeTreeData =
    new vscode.EventEmitter<BlastRadiusItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private rootNode: WireNode | null = null;
  private result: BlastRadiusResult | null = null;
  private loading = false;
  private treeView: vscode.TreeView<BlastRadiusItem> | null = null;

  /** Monotonically increasing counter to discard stale BFS results */
  private requestId = 0;

  constructor(private clientManager: GrafemaClientManager) {
    clientManager.on('reconnected', () => {
      this.rootNode = null;
      this.result = null;
      this.loading = false;
      this._onDidChangeTreeData.fire();
    });
  }

  /**
   * Store TreeView reference for future badge updates.
   * Called by extension.ts after createTreeView.
   */
  setTreeView(view: vscode.TreeView<BlastRadiusItem>): void {
    this.treeView = view;
  }

  /**
   * Set the root node and trigger async BFS computation.
   * Uses requestId pattern to discard stale results from rapid cursor moves.
   */
  setRootNode(node: WireNode | null): void {
    if (node && this.rootNode && node.id === this.rootNode.id) {
      return; // same node, skip
    }
    this.rootNode = node;
    this.result = null;
    this.requestId++;

    if (!node) {
      this.loading = false;
      this._onDidChangeTreeData.fire();
      return;
    }

    if (this.clientManager.isConnected()) {
      this.runBFS(node.id, this.requestId);
    } else {
      this._onDidChangeTreeData.fire();
    }
  }

  /**
   * Clear cache and re-run BFS with the current root node.
   */
  refresh(): void {
    const node = this.rootNode;
    this.result = null;
    this.requestId++;

    if (node && this.clientManager.isConnected()) {
      this.runBFS(node.id, this.requestId);
    } else {
      this._onDidChangeTreeData.fire();
    }
  }

  /**
   * Run BFS asynchronously and update tree when complete.
   * Discards results if requestId has changed (stale).
   */
  private async runBFS(rootNodeId: string, myRequestId: number): Promise<void> {
    this.loading = true;
    this._onDidChangeTreeData.fire();

    try {
      const client = this.clientManager.getClient();
      const bfsResult = await computeBlastRadius(client, rootNodeId, DEFAULT_MAX_DEPTH);

      // Discard stale result
      if (this.requestId !== myRequestId) {
        return;
      }

      this.result = bfsResult;
    } catch {
      // Discard stale result
      if (this.requestId !== myRequestId) {
        return;
      }
      this.result = null;
    } finally {
      // Only update if this is still the current request
      if (this.requestId === myRequestId) {
        this.loading = false;
        this._onDidChangeTreeData.fire();
      }
    }
  }

  getTreeItem(element: BlastRadiusItem): vscode.TreeItem {
    switch (element.kind) {
      case 'root': {
        const item = new vscode.TreeItem(
          element.label,
          vscode.TreeItemCollapsibleState.None
        );
        item.iconPath = getImpactIcon(element.impactLevel);
        item.contextValue = 'grafemaBlastRadiusRoot';

        if (element.file && element.line !== undefined) {
          item.command = {
            command: 'grafema.gotoLocation',
            title: 'Go to Location',
            arguments: [element.file, element.line, 0],
          };
        }

        return item;
      }

      case 'section': {
        const item = new vscode.TreeItem(
          element.label,
          vscode.TreeItemCollapsibleState.Expanded
        );
        item.iconPath = getSectionIcon(element.sectionKind);
        return item;
      }

      case 'dependent': {
        const item = new vscode.TreeItem(
          element.name,
          vscode.TreeItemCollapsibleState.None
        );
        item.iconPath = element.isIndirect
          ? new vscode.ThemeIcon('circle-outline')
          : new vscode.ThemeIcon('circle-filled');

        if (element.isIndirect && element.viaPath.length > 0) {
          const maxNames = 2;
          const names = element.viaPath.slice(0, maxNames);
          const suffix = element.viaPath.length > maxNames ? ', ...' : '';
          item.description = `via ${names.join(', ')}${suffix}`;
        }

        if (element.file) {
          const loc = element.line !== undefined ? `${element.file}:${element.line}` : element.file;
          item.tooltip = `${element.nodeType} "${element.name}"\n${loc}`;
        }

        if (element.file && element.line !== undefined) {
          item.command = {
            command: 'grafema.gotoLocation',
            title: 'Go to Location',
            arguments: [element.file, element.line, 0],
          };
        }

        return item;
      }

      case 'guarantee': {
        const item = new vscode.TreeItem(
          element.name,
          vscode.TreeItemCollapsibleState.None
        );
        item.iconPath = new vscode.ThemeIcon('warning');

        if (element.file) {
          item.command = {
            command: 'grafema.gotoLocation',
            title: 'Go to Location',
            arguments: [element.file, 1, 0],
          };
        }

        return item;
      }

      case 'summary': {
        const item = new vscode.TreeItem(
          element.text,
          vscode.TreeItemCollapsibleState.None
        );
        item.iconPath = new vscode.ThemeIcon('info');
        return item;
      }

      case 'status': {
        const item = new vscode.TreeItem(
          element.message,
          vscode.TreeItemCollapsibleState.None
        );
        return item;
      }

      case 'loading': {
        const item = new vscode.TreeItem(
          'Analyzing...',
          vscode.TreeItemCollapsibleState.None
        );
        item.iconPath = new vscode.ThemeIcon('loading~spin');
        return item;
      }

      default:
        return new vscode.TreeItem('Unknown item');
    }
  }

  async getChildren(element?: BlastRadiusItem): Promise<BlastRadiusItem[]> {
    // Root level
    if (!element) {
      if (!this.clientManager.isConnected()) {
        return [{ kind: 'status', message: 'Not connected to graph.' }];
      }
      if (!this.rootNode) {
        return [{ kind: 'status', message: 'Move cursor to a function or variable to see its blast radius.' }];
      }
      if (this.loading) {
        return [{ kind: 'loading' }];
      }
      if (!this.result) {
        return [{ kind: 'status', message: 'No dependents found.' }];
      }

      const r = this.result;
      const allZero = r.directDependents.length === 0
        && r.indirectDependents.length === 0
        && r.guaranteesAtRisk.length === 0;

      if (allZero) {
        return [{ kind: 'status', message: 'No dependents found.' }];
      }

      const rootMeta = this.rootNode ? parseNodeMetadata(this.rootNode) : {};
      const items: BlastRadiusItem[] = [];

      // Root label with impact badge
      items.push({
        kind: 'root',
        label: `${this.rootNode.nodeType} "${this.rootNode.name}" [${r.impactLevel}]`,
        impactLevel: r.impactLevel,
        file: this.rootNode.file || undefined,
        line: typeof rootMeta.line === 'number' ? rootMeta.line : undefined,
      });

      // Direct section (only if > 0)
      if (r.directDependents.length > 0) {
        items.push({
          kind: 'section',
          label: `Direct dependents (${r.directDependents.length})`,
          sectionKind: 'direct',
          count: r.directDependents.length,
        });
      }

      // Indirect section (only if > 0)
      if (r.indirectDependents.length > 0) {
        items.push({
          kind: 'section',
          label: `Indirect dependents (${r.indirectDependents.length})`,
          sectionKind: 'indirect',
          count: r.indirectDependents.length,
        });
      }

      // Guarantee section (only if > 0)
      if (r.guaranteesAtRisk.length > 0) {
        items.push({
          kind: 'section',
          label: `Guarantees at risk (${r.guaranteesAtRisk.length})`,
          sectionKind: 'guarantee',
          count: r.guaranteesAtRisk.length,
        });
      }

      // Summary line
      const guaranteePart = r.guaranteesAtRisk.length > 0
        ? ` \u00B7 ${r.guaranteesAtRisk.length} guarantee${r.guaranteesAtRisk.length === 1 ? '' : 's'}`
        : '';
      items.push({
        kind: 'summary',
        text: `${r.totalCount} total \u00B7 ${r.fileCount} file${r.fileCount === 1 ? '' : 's'}${guaranteePart}`,
      });

      return items;
    }

    // Section children
    if (element.kind === 'section' && this.result) {
      if (element.sectionKind === 'direct') {
        return this.result.directDependents.map((dep) => ({
          kind: 'dependent' as const,
          name: dep.name,
          file: dep.file,
          line: dep.line,
          nodeType: dep.nodeType,
          viaPath: dep.viaPath,
          isIndirect: false,
        }));
      }

      if (element.sectionKind === 'indirect') {
        return this.result.indirectDependents.map((dep) => ({
          kind: 'dependent' as const,
          name: dep.name,
          file: dep.file,
          line: dep.line,
          nodeType: dep.nodeType,
          viaPath: dep.viaPath,
          isIndirect: true,
        }));
      }

      if (element.sectionKind === 'guarantee') {
        return this.result.guaranteesAtRisk.map((g) => ({
          kind: 'guarantee' as const,
          name: g.name,
          file: g.file,
          metadata: g.metadata,
        }));
      }
    }

    return [];
  }

  getParent(_element: BlastRadiusItem): null {
    return null;
  }
}

/**
 * Get icon for impact level.
 * LOW: pass (green), MEDIUM: warning (yellow), HIGH: error (red)
 */
function getImpactIcon(level: 'LOW' | 'MEDIUM' | 'HIGH'): vscode.ThemeIcon {
  switch (level) {
    case 'LOW':
      return new vscode.ThemeIcon('pass');
    case 'MEDIUM':
      return new vscode.ThemeIcon('warning');
    case 'HIGH':
      return new vscode.ThemeIcon('error');
  }
}

/**
 * Get icon for section kind.
 */
function getSectionIcon(sectionKind: 'direct' | 'indirect' | 'guarantee'): vscode.ThemeIcon {
  switch (sectionKind) {
    case 'direct':
      return new vscode.ThemeIcon('circle-filled');
    case 'indirect':
      return new vscode.ThemeIcon('circle-outline');
    case 'guarantee':
      return new vscode.ThemeIcon('warning');
  }
}
