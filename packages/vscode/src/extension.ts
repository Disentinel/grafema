/**
 * Grafema Explore - VS Code Extension Entry Point
 *
 * Provides interactive graph navigation for Grafema code analysis.
 * Manual exploration mode - user explicitly selects nodes to explore.
 */

import * as vscode from 'vscode';
import type { WireNode } from '@grafema/types';
import { GrafemaClientManager } from './grafemaClient';
import { EdgesProvider } from './edgesProvider';
import { findNodeAtCursor } from './nodeLocator';
import { parseNodeMetadata, GraphTreeItem } from './types';

let clientManager: GrafemaClientManager | null = null;
let edgesProvider: EdgesProvider | null = null;
let treeView: vscode.TreeView<GraphTreeItem> | null = null;

/**
 * Extension activation
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  console.log('[grafema-explore] Activating extension');

  // Get workspace root
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    vscode.window.showWarningMessage('Grafema Explore: No workspace folder open');
    return;
  }

  const workspaceRoot = workspaceFolders[0].uri.fsPath;

  // Initialize client manager
  clientManager = new GrafemaClientManager(workspaceRoot);

  // Initialize tree provider
  edgesProvider = new EdgesProvider(clientManager);

  // Register tree view
  treeView = vscode.window.createTreeView('grafemaExplore', {
    treeDataProvider: edgesProvider,
    showCollapseAll: true,
  });

  // Update welcome message based on connection state
  clientManager.on('stateChange', () => {
    const message = edgesProvider?.getStatusMessage();
    if (message && treeView) {
      treeView.message = message;
    } else if (treeView) {
      treeView.message = undefined;
    }
  });

  // === COMMANDS ===

  // Go to file location (doesn't change tree state)
  const gotoCommand = vscode.commands.registerCommand(
    'grafema.gotoLocation',
    async (file: string, line: number, column: number) => {
      try {
        const uri = vscode.Uri.file(file);
        const position = new vscode.Position(Math.max(0, line - 1), column);
        const document = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(document);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
      } catch (err) {
        console.error('[grafema-explore] Error navigating:', err);
        vscode.window.showErrorMessage(`Failed to open ${file}`);
      }
    }
  );

  // Find node at cursor and set as root (clears history)
  const findAtCursorCommand = vscode.commands.registerCommand('grafema.findAtCursor', async () => {
    await findAndSetRoot(false);
  });

  // Set selected tree item as new root (preserves history)
  const setAsRootCommand = vscode.commands.registerCommand(
    'grafema.setAsRoot',
    async (item: GraphTreeItem) => {
      if (!edgesProvider) return;

      let node: WireNode | null = null;

      if (item.kind === 'node') {
        node = item.node;
      } else if (item.kind === 'edge' && item.targetNode) {
        node = item.targetNode;
      } else if (item.kind === 'edge' && clientManager?.isConnected()) {
        // Fetch target node if not pre-loaded
        const targetId = item.direction === 'outgoing' ? item.edge.dst : item.edge.src;
        node = await clientManager.getClient().getNode(targetId);
      }

      if (node) {
        edgesProvider.navigateToNode(node);
      }
    }
  );

  // Refresh current view
  const refreshCommand = vscode.commands.registerCommand('grafema.refreshEdges', () => {
    edgesProvider?.refresh();
  });

  // Connect to RFDB
  try {
    await clientManager.connect();
  } catch (err) {
    console.error('[grafema-explore] Connection error:', err);
    edgesProvider.setStatusMessage('Connection failed');
  }

  // Register disposables
  context.subscriptions.push(
    treeView,
    gotoCommand,
    findAtCursorCommand,
    setAsRootCommand,
    refreshCommand,
    {
      dispose: () => {
        clientManager?.disconnect();
      },
    }
  );

  console.log('[grafema-explore] Extension activated');
}

/**
 * Find node at current cursor and set as root
 */
async function findAndSetRoot(preserveHistory: boolean): Promise<void> {
  if (!edgesProvider || !clientManager) {
    return;
  }

  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    edgesProvider.setStatusMessage('No active editor');
    return;
  }

  if (!clientManager.isConnected()) {
    edgesProvider.setStatusMessage('Not connected to graph');
    return;
  }

  const document = editor.document;
  const position = editor.selection.active;
  const filePath = document.uri.fsPath;
  const line = position.line + 1;
  const column = position.character;

  try {
    const client = clientManager.getClient();
    const node = await findNodeAtCursor(client, filePath, line, column);

    if (node) {
      if (preserveHistory) {
        edgesProvider.navigateToNode(node);
      } else {
        edgesProvider.clearAndSetRoot(node);
      }
    } else {
      edgesProvider.setStatusMessage('No graph node at cursor');
    }
  } catch (err) {
    console.error('[grafema-explore] Error finding node:', err);
    edgesProvider.setStatusMessage('Error querying graph');
  }
}

/**
 * Extension deactivation
 */
export function deactivate(): void {
  console.log('[grafema-explore] Deactivating extension');
  clientManager?.disconnect();
}
