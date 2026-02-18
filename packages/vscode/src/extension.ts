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
import type { GraphTreeItem } from './types';
import { parseNodeMetadata } from './types';

let clientManager: GrafemaClientManager | null = null;
let edgesProvider: EdgesProvider | null = null;
let treeView: vscode.TreeView<GraphTreeItem> | null = null;
let followCursor = true; // Follow cursor mode (toggle with cmd+shift+g)
let statusBarItem: vscode.StatusBarItem | null = null;
let selectedTreeItem: GraphTreeItem | null = null; // Track selected item for state export

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

  // Get paths from settings (if configured)
  const config = vscode.workspace.getConfiguration('grafema');
  const rfdbServerPath = config.get<string>('rfdbServerPath') || undefined;
  const rfdbSocketPath = config.get<string>('rfdbSocketPath') || undefined;

  // Initialize client manager
  clientManager = new GrafemaClientManager(workspaceRoot, rfdbServerPath, rfdbSocketPath);

  // Initialize tree provider
  edgesProvider = new EdgesProvider(clientManager);

  // Register tree view
  treeView = vscode.window.createTreeView('grafemaExplore', {
    treeDataProvider: edgesProvider,
    showCollapseAll: true,
  });

  // Track selection changes for state export
  const selectionTracker = treeView.onDidChangeSelection((event) => {
    selectedTreeItem = event.selection[0] ?? null;
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

  // Clear caches when reconnected (database may have changed)
  clientManager.on('reconnected', () => {
    console.log('[grafema-explore] Reconnected - clearing history');
    edgesProvider?.clearHistory();
    edgesProvider?.setRootNode(null);
    vscode.window.showInformationMessage('Grafema: Reconnected to graph database');
  });

  // Register commands, status bar, and cursor listener
  const disposables = registerCommands();

  // Connect to RFDB
  try {
    await clientManager.connect();
  } catch (err) {
    console.error('[grafema-explore] Connection error:', err);
    edgesProvider.setStatusMessage('Connection failed');
  }

  // Register all disposables
  context.subscriptions.push(
    treeView,
    selectionTracker,
    ...disposables,
    {
      dispose: () => {
        clientManager?.disconnect();
      },
    }
  );

  console.log('[grafema-explore] Extension activated');
}

/**
 * Register all extension commands, status bar, and cursor listener.
 * Returns disposables array for cleanup.
 */
function registerCommands(): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];

  // Go to file location (doesn't change tree state)
  disposables.push(vscode.commands.registerCommand(
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
  ));

  // Find node at cursor and set as root (clears history)
  disposables.push(vscode.commands.registerCommand('grafema.findAtCursor', async () => {
    await findAndSetRoot(false);
  }));

  // Set selected tree item as new root (preserves history)
  disposables.push(vscode.commands.registerCommand(
    'grafema.setAsRoot',
    async (item: GraphTreeItem) => {
      if (!edgesProvider) return;

      let node: WireNode | null = null;

      if (item.kind === 'node') {
        node = item.node;
      } else if (item.kind === 'edge' && item.targetNode) {
        node = item.targetNode;
      } else if (item.kind === 'edge' && clientManager?.isConnected()) {
        const targetId = item.direction === 'outgoing' ? item.edge.dst : item.edge.src;
        node = await clientManager.getClient().getNode(targetId);
      }

      if (node) {
        edgesProvider.navigateToNode(node);
      }
    }
  ));

  // Refresh current view
  disposables.push(vscode.commands.registerCommand('grafema.refreshEdges', () => {
    edgesProvider?.refresh();
  }));

  // Go back to previous root
  disposables.push(vscode.commands.registerCommand('grafema.goBack', () => {
    if (edgesProvider?.canGoBack()) {
      edgesProvider.goBack();
    } else {
      vscode.window.showInformationMessage('Grafema: No history to go back to');
    }
  }));

  // Toggle follow cursor mode
  disposables.push(vscode.commands.registerCommand('grafema.toggleFollowCursor', () => {
    followCursor = !followCursor;
    updateStatusBar();
    if (followCursor) {
      findAndSetRoot(false);
      vscode.window.showInformationMessage('Grafema: Follow cursor enabled');
    } else {
      vscode.window.showInformationMessage('Grafema: Follow cursor disabled (locked)');
    }
  }));

  // Copy tree state to clipboard for debugging
  disposables.push(vscode.commands.registerCommand('grafema.copyTreeState', async () => {
    if (!clientManager || !edgesProvider) {
      vscode.window.showErrorMessage('Grafema: Extension not initialized');
      return;
    }

    const state = await buildTreeState(clientManager, edgesProvider, selectedTreeItem);
    const json = JSON.stringify(state, null, 2);
    await vscode.env.clipboard.writeText(json);
    vscode.window.showInformationMessage('Grafema: Tree state copied to clipboard');
  }));

  // Status bar
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'grafema.toggleFollowCursor';
  updateStatusBar();
  statusBarItem.show();
  disposables.push(statusBarItem);

  // Follow cursor on selection change
  disposables.push(vscode.window.onDidChangeTextEditorSelection(
    debounce(async (_event: vscode.TextEditorSelectionChangeEvent) => {
      if (followCursor && clientManager?.isConnected()) {
        await findAndSetRoot(false);
      }
    }, 150)
  ));

  return disposables;
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
 * Update status bar to show follow cursor state
 */
function updateStatusBar(): void {
  if (!statusBarItem) return;

  if (followCursor) {
    statusBarItem.text = '$(eye) Grafema: Follow';
    statusBarItem.tooltip = 'Grafema: Following cursor (click to lock)';
  } else {
    statusBarItem.text = '$(lock) Grafema: Locked';
    statusBarItem.tooltip = 'Grafema: Locked (click to follow cursor)';
  }
}

/**
 * Simple debounce helper
 */
function debounce<Args extends unknown[]>(
  fn: (...args: Args) => void | Promise<void>,
  delay: number
): (...args: Args) => void {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  return (...args: Args) => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    timeoutId = setTimeout(() => {
      fn(...args);
      timeoutId = null;
    }, delay);
  };
}

/**
 * Build tree state object for debugging export
 */
interface NodeStateInfo {
  id: string;
  type: string;
  name: string;
  file: string;
  line?: number;
}

interface TreeStateExport {
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

function nodeToStateInfo(node: WireNode): NodeStateInfo {
  const metadata = parseNodeMetadata(node);
  return {
    id: node.id,
    type: node.nodeType,
    name: node.name,
    file: node.file,
    line: metadata.line,
  };
}

async function buildTreeState(
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

/**
 * Extension deactivation
 */
export function deactivate(): void {
  console.log('[grafema-explore] Deactivating extension');
  clientManager?.disconnect();
}
