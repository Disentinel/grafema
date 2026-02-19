/**
 * Debug TreeDataProvider for Grafema sidebar.
 *
 * Shows a log of all queries sent to RFDB server and their responses.
 * Helps diagnose issues like file path mismatches, missing nodes, etc.
 */

import * as vscode from 'vscode';

export interface DebugEntry {
  timestamp: number;
  operation: string;
  query: Record<string, unknown>;
  result: string;
  details?: string[];
}

class DebugItem extends vscode.TreeItem {
  constructor(
    label: string,
    description?: string,
    collapsible?: vscode.TreeItemCollapsibleState,
    public readonly children?: DebugItem[],
  ) {
    super(label, collapsible ?? vscode.TreeItemCollapsibleState.None);
    this.description = description;
  }
}

const MAX_ENTRIES = 50;

export class DebugProvider implements vscode.TreeDataProvider<DebugItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<DebugItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private entries: DebugEntry[] = [];

  log(entry: DebugEntry): void {
    this.entries.unshift(entry); // newest first
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.pop();
    }
    this._onDidChangeTreeData.fire();
  }

  clear(): void {
    this.entries = [];
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: DebugItem): DebugItem {
    return element;
  }

  getChildren(element?: DebugItem): DebugItem[] {
    if (element?.children) {
      return element.children;
    }

    if (element) {
      return [];
    }

    if (this.entries.length === 0) {
      return [new DebugItem('No queries yet', 'interact with the extension to see debug info')];
    }

    return this.entries.map((entry) => {
      const time = new Date(entry.timestamp).toLocaleTimeString();
      const children: DebugItem[] = [];

      // Query details
      for (const [key, value] of Object.entries(entry.query)) {
        const valueStr = typeof value === 'string' ? value : JSON.stringify(value);
        children.push(new DebugItem(`${key}:`, valueStr));
      }

      // Extra details
      if (entry.details) {
        for (const detail of entry.details) {
          children.push(new DebugItem(detail));
        }
      }

      const item = new DebugItem(
        `${entry.operation}`,
        `${entry.result} (${time})`,
        vscode.TreeItemCollapsibleState.Collapsed,
        children,
      );

      // Color based on result
      if (entry.result.startsWith('error') || entry.result === '0 nodes') {
        item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('editorWarning.foreground'));
      } else {
        item.iconPath = new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green'));
      }

      return item;
    });
  }
}
