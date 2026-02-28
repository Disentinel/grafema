/**
 * Nodes in File Provider — TreeDataProvider for the NODES IN FILE debug panel.
 *
 * Shows all graph nodes present in the currently active file, sorted by position.
 * Supports checkboxes to highlight node ranges in the editor via decorations.
 * Used for visual coverage analysis: highlighted regions = covered by graph nodes,
 * unhighlighted gaps = missing graph coverage.
 *
 * Uses Pattern B (createTreeView) so extension.ts can listen to
 * view.onDidChangeCheckboxState for native checkbox handling.
 */

import * as vscode from 'vscode';
import type { WireNode } from '@grafema/types';
import type { GrafemaClientManager } from './grafemaClient';
import { parseNodeMetadata } from './types';
import type { NodeInFileItem } from './types';
import { getNodeIcon } from './utils';

export class NodesInFileProvider
  implements vscode.TreeDataProvider<NodeInFileItem>, vscode.Disposable
{
  private _onDidChangeTreeData =
    new vscode.EventEmitter<NodeInFileItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private currentFile: string | undefined;
  private nodes: WireNode[] = [];
  private checkedIds = new Set<string>();
  private readonly decorationType: vscode.TextEditorDecorationType;

  constructor(private clientManager: GrafemaClientManager) {
    this.decorationType = vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
      border: '1px solid',
      borderColor: new vscode.ThemeColor('editor.findMatchHighlightBorder'),
    });

    clientManager.on('reconnected', () => {
      this.nodes = [];
      this.checkedIds.clear();
      this._onDidChangeTreeData.fire();
      this.updateDecorations();
    });
  }

  /**
   * Load all nodes for the given file path (relative to workspace root).
   * Clears checked state and decorations. Called when active editor changes.
   */
  async setFile(filePath: string | undefined): Promise<void> {
    this.currentFile = filePath;
    this.checkedIds.clear();

    if (filePath && this.clientManager.isConnected()) {
      try {
        const allNodes = await this.clientManager.getClient().getAllNodes({ file: filePath });
        this.nodes = allNodes.sort((a, b) => {
          const ma = parseNodeMetadata(a);
          const mb = parseNodeMetadata(b);
          return (ma.line ?? 0) - (mb.line ?? 0) || (ma.column ?? 0) - (mb.column ?? 0);
        });
      } catch {
        this.nodes = [];
      }
    } else {
      this.nodes = [];
    }

    this._onDidChangeTreeData.fire();
    this.updateDecorations();
  }

  /**
   * Reload nodes for the current file (e.g., after re-analysis).
   */
  refresh(): void {
    void this.setFile(this.currentFile);
  }

  /**
   * Check all nodes — highlights the entire covered portion of the file.
   */
  checkAll(): void {
    this.checkedIds = new Set(this.nodes.map((n) => n.id));
    this._onDidChangeTreeData.fire();
    this.updateDecorations();
  }

  /**
   * Uncheck all nodes — clears all decorations.
   */
  uncheckAll(): void {
    this.checkedIds.clear();
    this._onDidChangeTreeData.fire();
    this.updateDecorations();
  }

  /**
   * Set checkbox state for a single item.
   * Called from the TreeView onDidChangeCheckboxState event in extension.ts.
   */
  setItemChecked(id: string, checked: boolean): void {
    if (checked) {
      this.checkedIds.add(id);
    } else {
      this.checkedIds.delete(id);
    }
    this._onDidChangeTreeData.fire();
    this.updateDecorations();
  }

  getTreeItem(element: NodeInFileItem): vscode.TreeItem {
    const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
    item.description = element.description;
    item.checkboxState = this.checkedIds.has(element.id)
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;
    item.iconPath = getNodeIcon(element.nodeType);
    item.command = {
      command: 'grafema.gotoLocation',
      title: 'Go to Location',
      arguments: [element.file, element.line, element.column],
    };
    return item;
  }

  getChildren(element?: NodeInFileItem): NodeInFileItem[] {
    // Flat list — no nested children
    if (element) return [];

    return this.nodes.map((n) => {
      const m = parseNodeMetadata(n);
      const endPart = m.endLine != null ? ` → L${m.endLine}:${m.endColumn ?? 0}` : '';
      return {
        id: n.id,
        label: `${n.nodeType}  ${n.name || '(anonymous)'}`,
        description: `L${m.line ?? 0}:${m.column ?? 0}${endPart}`,
        nodeType: n.nodeType,
        file: n.file || undefined,
        line: m.line ?? 0,
        column: m.column ?? 0,
        endLine: m.endLine,
        endColumn: m.endColumn,
      };
    });
  }

  private updateDecorations(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const ranges: vscode.DecorationOptions[] = [];

    for (const node of this.nodes) {
      if (!this.checkedIds.has(node.id)) continue;
      const m = parseNodeMetadata(node);
      if (m.line == null) continue;

      const startLine = m.line - 1; // VS Code is 0-indexed
      const startCol = m.column ?? 0;
      const endLine = m.endLine != null ? m.endLine - 1 : startLine;
      const endCol = m.endColumn != null ? m.endColumn : startCol + (node.name?.length ?? 1);

      ranges.push({
        range: new vscode.Range(startLine, startCol, endLine, endCol),
        hoverMessage: `${node.nodeType}: ${node.name}`,
      });
    }

    editor.setDecorations(this.decorationType, ranges);
  }

  dispose(): void {
    this.decorationType.dispose();
  }
}
