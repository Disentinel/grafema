/**
 * Status TreeDataProvider for Grafema sidebar.
 *
 * Shows connection state, server version, and graph statistics
 * in a flat list under the STATUS view.
 */

import * as vscode from 'vscode';
import type { GrafemaClientManager } from './grafemaClient';
import type { GraphStats } from './types';

class StatusItem extends vscode.TreeItem {
  constructor(
    label: string,
    description?: string,
    icon?: vscode.ThemeIcon,
    command?: vscode.Command,
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    if (icon) this.iconPath = icon;
    if (command) this.command = command;
  }
}

export class StatusProvider implements vscode.TreeDataProvider<StatusItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<StatusItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private cachedStats: GraphStats | null = null;
  private clientManager: GrafemaClientManager;

  constructor(clientManager: GrafemaClientManager) {
    this.clientManager = clientManager;

    clientManager.on('stateChange', () => {
      if (clientManager.isConnected()) {
        this.refreshStats();
      } else {
        this.cachedStats = null;
        this._onDidChangeTreeData.fire();
      }
    });

    clientManager.on('reconnected', () => {
      this.refreshStats();
    });
  }

  private async refreshStats(): Promise<void> {
    this.cachedStats = await this.clientManager.getStats();
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: StatusItem): StatusItem {
    return element;
  }

  async getChildren(): Promise<StatusItem[]> {
    const state = this.clientManager.state;
    const items: StatusItem[] = [];

    switch (state.status) {
      case 'connected': {
        const stats = this.cachedStats;
        const versionDesc = stats ? `rfdb ${stats.version}` : '';
        items.push(new StatusItem(
          'Connected',
          versionDesc,
          new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('charts.green')),
        ));
        if (stats) {
          const dbName = stats.dbPath.split('/').pop() || stats.dbPath;
          items.push(new StatusItem(`Nodes: ${stats.nodeCount.toLocaleString()}`));
          items.push(new StatusItem(`Edges: ${stats.edgeCount.toLocaleString()}`));
          items.push(new StatusItem(`Database: ${dbName}`));
        }
        break;
      }
      case 'connecting':
        items.push(new StatusItem(
          'Connecting...',
          undefined,
          new vscode.ThemeIcon('loading~spin'),
        ));
        items.push(new StatusItem(`Socket: ${this.clientManager.socketPath}`));
        break;
      case 'starting-server':
        items.push(new StatusItem(
          'Starting server...',
          undefined,
          new vscode.ThemeIcon('loading~spin'),
        ));
        items.push(new StatusItem(`Socket: ${this.clientManager.socketPath}`));
        break;
      case 'error':
        items.push(new StatusItem(
          'Connection failed',
          undefined,
          new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground')),
        ));
        items.push(new StatusItem(state.message));
        items.push(new StatusItem(`Socket: ${this.clientManager.socketPath}`));
        break;
      case 'no-database':
        items.push(new StatusItem(
          'No database found',
          undefined,
          new vscode.ThemeIcon('circle-large-outline', new vscode.ThemeColor('disabledForeground')),
        ));
        items.push(new StatusItem('Run: grafema analyze'));
        break;
      case 'disconnected':
        items.push(new StatusItem(
          'Disconnected',
          undefined,
          new vscode.ThemeIcon('circle-large-outline', new vscode.ThemeColor('disabledForeground')),
        ));
        break;
    }

    return items;
  }
}
