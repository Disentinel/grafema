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
import { StatusProvider } from './statusProvider';
import { DebugProvider } from './debugProvider';
import { findNodeAtCursor } from './nodeLocator';
import type { GraphTreeItem } from './types';
import { parseNodeMetadata } from './types';

let clientManager: GrafemaClientManager | null = null;
let edgesProvider: EdgesProvider | null = null;
let statusProvider: StatusProvider | null = null;
let debugProvider: DebugProvider | null = null;
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

  // Register status provider
  statusProvider = new StatusProvider(clientManager);
  const statusTreeRegistration = vscode.window.registerTreeDataProvider('grafemaStatus', statusProvider);

  // Register debug provider
  debugProvider = new DebugProvider();
  const debugTreeRegistration = vscode.window.registerTreeDataProvider('grafemaDebug', debugProvider);

  // Register tree view
  treeView = vscode.window.createTreeView('grafemaExplore', {
    treeDataProvider: edgesProvider,
    showCollapseAll: true,
  });

  // Track selection changes for state export
  const selectionTracker = treeView.onDidChangeSelection((event) => {
    selectedTreeItem = event.selection[0] ?? null;
  });

  // Update welcome message and status bar based on connection state
  clientManager.on('stateChange', async () => {
    const message = edgesProvider?.getStatusMessage();
    if (message && treeView) {
      treeView.message = message;
    } else if (treeView) {
      treeView.message = undefined;
    }
    updateStatusBar();
    // Fetch stats asynchronously for status bar node count
    if (clientManager?.isConnected()) {
      const stats = await clientManager.getStats();
      if (stats && statusBarItem) {
        statusBarItem.text = `$(pass-filled) Grafema: ${stats.nodeCount.toLocaleString()} nodes`;
      }
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
    statusTreeRegistration,
    debugTreeRegistration,
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
        // Graph stores relative paths — resolve to absolute using workspace root
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const absFile = wsRoot && !file.startsWith('/') ? `${wsRoot}/${file}` : file;
        const uri = vscode.Uri.file(absFile);
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

  // Search nodes in graph — streaming search with timeout
  const SEARCH_TIMEOUT_MS = 5000;
  const SEARCH_MAX_RESULTS = 50;

  disposables.push(vscode.commands.registerCommand('grafema.searchNodes', async () => {
    if (!clientManager?.isConnected() || !edgesProvider) {
      vscode.window.showWarningMessage('Grafema: Not connected to graph');
      return;
    }

    const client = clientManager.getClient();

    const quickPick = vscode.window.createQuickPick();
    quickPick.placeholder = 'Search: exact name, or TYPE:substring (e.g. FUNCTION:handle, MODULE:)';
    quickPick.matchOnDescription = true;

    const nodeIdMap = new Map<string, string>(); // detail display text → numeric id
    let activeAbort: AbortController | null = null;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    quickPick.onDidChangeValue((value) => {
      // Cancel previous search
      if (activeAbort) activeAbort.abort();
      if (debounceTimer) clearTimeout(debounceTimer);

      if (!value || value.length < 2) {
        quickPick.items = [];
        return;
      }

      debounceTimer = setTimeout(async () => {
        const abort = new AbortController();
        activeAbort = abort;

        // Parse TYPE:name syntax
        const colonIdx = value.indexOf(':');
        let typeFilter = '';
        let nameFilter = '';
        if (colonIdx > 0) {
          typeFilter = value.slice(0, colonIdx).toUpperCase();
          nameFilter = value.slice(colonIdx + 1).toLowerCase();
        } else {
          nameFilter = value.toLowerCase();
        }

        // Build RFDB query — use exact match fields where possible
        const query: Record<string, string> = {};
        if (typeFilter) query.nodeType = typeFilter;
        // If no type prefix and input looks like an exact name (no spaces), try exact match
        if (!typeFilter && !nameFilter.includes(' ')) query.name = value;

        quickPick.busy = true;
        const startTime = Date.now();

        try {
          const matches: WireNode[] = [];
          const timeoutPromise = new Promise<'timeout'>((resolve) =>
            setTimeout(() => resolve('timeout'), SEARCH_TIMEOUT_MS)
          );

          // Stream results — collect up to SEARCH_MAX_RESULTS
          const streamPromise = (async () => {
            for await (const node of client.queryNodes(query)) {
              if (abort.signal.aborted) return 'aborted';
              // If we used exact name query, accept all results
              // If we used type query, filter by name substring
              if (typeFilter && nameFilter && !node.name.toLowerCase().includes(nameFilter)) {
                continue;
              }
              matches.push(node);
              if (matches.length >= SEARCH_MAX_RESULTS) return 'limit';
            }
            return 'done';
          })();

          const reason = await Promise.race([streamPromise, timeoutPromise]);
          if (abort.signal.aborted) return;

          const elapsed = Date.now() - startTime;
          debugProvider?.log({
            timestamp: Date.now(),
            operation: 'searchNodes',
            query: { ...query, nameFilter: nameFilter || '(none)' },
            result: `${matches.length} found (${reason}, ${elapsed}ms)`,
            details: matches.slice(0, 5).map((n) => `${n.nodeType} "${n.name}" ${n.file}`),
          });

          if (matches.length === 0) {
            const hint = !typeFilter
              ? 'Try TYPE:name syntax (e.g. FUNCTION:handle)'
              : `no "${typeFilter}" nodes${nameFilter ? ` matching "${nameFilter}"` : ''}`;
            quickPick.items = [{
              label: `$(circle-slash) No results`,
              description: hint,
              alwaysShow: true,
            }];
          } else {
            const items: vscode.QuickPickItem[] = [];
            nodeIdMap.clear();
            for (const node of matches) {
              const meta = JSON.parse(node.metadata || '{}');
              const loc = meta.line ? `:${meta.line}` : '';
              const displayId = node.semanticId || node.id;
              nodeIdMap.set(displayId, node.id);
              items.push({
                label: `$(symbol-${getIconName(node.nodeType)}) ${node.nodeType} "${node.name}"`,
                description: `${node.file}${loc}`,
                detail: displayId,
                alwaysShow: true,
              });
            }
            if (reason === 'limit') {
              items.push({
                label: `$(info) ${SEARCH_MAX_RESULTS}+ results, refine your query`,
                kind: vscode.QuickPickItemKind.Separator,
              });
            }
            quickPick.items = items;
          }
        } catch (err) {
          if (abort.signal.aborted) return;
          const message = err instanceof Error ? err.message : String(err);
          debugProvider?.log({
            timestamp: Date.now(),
            operation: 'searchNodes',
            query,
            result: `error: ${message}`,
          });
          quickPick.items = [{ label: `$(error) Search failed: ${message}` }];
        } finally {
          if (!abort.signal.aborted) quickPick.busy = false;
        }
      }, 300);
    });

    quickPick.onDidAccept(() => {
      const selected = quickPick.selectedItems[0];
      if (selected?.detail && clientManager?.isConnected()) {
        const nodeId = nodeIdMap.get(selected.detail) || selected.detail;
        clientManager.getClient().getNode(nodeId).then((node) => {
          if (node && edgesProvider) {
            edgesProvider.navigateToNode(node);
          }
        });
      }
      quickPick.dispose();
    });

    quickPick.onDidHide(() => {
      if (activeAbort) activeAbort.abort();
      quickPick.dispose();
    });

    quickPick.show();
  }));

  // Find node at cursor and set as root (clears history)
  disposables.push(vscode.commands.registerCommand('grafema.findAtCursor', async () => {
    console.log('[grafema-explore] findAtCursor command fired');
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

  // Filter tree — opens VS Code's built-in find widget for the tree view
  disposables.push(vscode.commands.registerCommand('grafema.filterTree', () => {
    vscode.commands.executeCommand('grafemaExplore.focus').then(() => {
      vscode.commands.executeCommand('list.find');
    });
  }));

  // Focus status view command
  disposables.push(vscode.commands.registerCommand('grafema.focusStatus', () => {
    vscode.commands.executeCommand('grafemaStatus.focus');
  }));

  // Clear debug log command
  disposables.push(vscode.commands.registerCommand('grafema.clearDebugLog', () => {
    debugProvider?.clear();
  }));

  // Status bar — click focuses STATUS view
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'grafema.focusStatus';
  updateStatusBar();
  statusBarItem.show();
  disposables.push(statusBarItem);

  // Follow cursor on selection change
  disposables.push(vscode.window.onDidChangeTextEditorSelection(
    debounce(async (_event: vscode.TextEditorSelectionChangeEvent) => {
      console.log(`[grafema-explore] selection changed, followCursor=${followCursor}, connected=${clientManager?.isConnected()}`);
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
  console.log('[grafema-explore] findAndSetRoot called');

  if (!edgesProvider || !clientManager) {
    console.log('[grafema-explore] findAndSetRoot: no edgesProvider or clientManager');
    debugProvider?.log({
      timestamp: Date.now(),
      operation: 'findAndSetRoot',
      query: {},
      result: 'error: extension not initialized',
      details: [`edgesProvider: ${!!edgesProvider}`, `clientManager: ${!!clientManager}`],
    });
    return;
  }

  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    console.log('[grafema-explore] findAndSetRoot: no active editor');
    debugProvider?.log({
      timestamp: Date.now(),
      operation: 'findAndSetRoot',
      query: {},
      result: 'error: no active editor',
    });
    edgesProvider.setStatusMessage('No active editor');
    return;
  }

  if (!clientManager.isConnected()) {
    console.log('[grafema-explore] findAndSetRoot: not connected');
    debugProvider?.log({
      timestamp: Date.now(),
      operation: 'findAndSetRoot',
      query: {},
      result: `error: not connected (status: ${clientManager.state.status})`,
    });
    edgesProvider.setStatusMessage('Not connected to graph');
    return;
  }

  const document = editor.document;
  const position = editor.selection.active;
  const absPath = document.uri.fsPath;
  const line = position.line + 1;
  const column = position.character;

  // Convert absolute path to relative (graph stores paths relative to workspace root)
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const filePath = workspaceRoot && absPath.startsWith(workspaceRoot)
    ? absPath.slice(workspaceRoot.length + 1) // +1 for trailing slash
    : absPath;
  console.log(`[grafema-explore] findAndSetRoot: file=${filePath} L${line}:${column}`);

  try {
    const client = clientManager.getClient();

    // Debug: log the raw query before node search
    const allNodes = await client.getAllNodes({ file: filePath });
    const details: string[] = [
      `cursor: L${line}:${column}`,
      `getAllNodes({ file }) returned ${allNodes.length} nodes`,
    ];

    if (allNodes.length === 0) {
      // Try a small sample query to see what file paths look like in the graph
      const sampleNodes = await client.getAllNodes({ nodeType: 'MODULE' });
      const files = new Set(sampleNodes.slice(0, 20).map((n) => n.file));
      details.push(`--- sample MODULE files in graph (first ${files.size}) ---`);
      for (const f of files) {
        details.push(`  ${f}`);
      }
    } else {
      // Show first few nodes for context
      for (const n of allNodes.slice(0, 5)) {
        const meta = JSON.parse(n.metadata || '{}');
        details.push(`  ${n.nodeType} "${n.name}" L${meta.line ?? '?'}:${meta.column ?? '?'}`);
      }
      if (allNodes.length > 5) {
        details.push(`  ... and ${allNodes.length - 5} more`);
      }
    }

    const node = await findNodeAtCursor(client, filePath, line, column);

    debugProvider?.log({
      timestamp: Date.now(),
      operation: 'findNodeAtCursor',
      query: { file: filePath, line, column },
      result: node
        ? `found: ${node.nodeType} "${node.name}"`
        : `${allNodes.length} nodes in file, none matched`,
      details,
    });

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
    const message = err instanceof Error ? err.message : String(err);
    console.error('[grafema-explore] Error finding node:', err);
    debugProvider?.log({
      timestamp: Date.now(),
      operation: 'findNodeAtCursor',
      query: { file: filePath, line, column },
      result: `error: ${message}`,
    });
    edgesProvider.setStatusMessage('Error querying graph');
  }
}

/**
 * Update status bar to show connection state + follow mode in tooltip
 */
function updateStatusBar(): void {
  if (!statusBarItem) return;

  const followState = followCursor ? 'Following cursor' : 'Locked';
  const state = clientManager?.state;

  switch (state?.status) {
    case 'connected':
      statusBarItem.text = '$(pass-filled) Grafema';
      statusBarItem.tooltip = `Grafema: Connected | ${followState} (Cmd+Shift+G to toggle)`;
      break;
    case 'connecting':
      statusBarItem.text = '$(loading~spin) Grafema: connecting...';
      statusBarItem.tooltip = 'Grafema: Connecting to RFDB server';
      break;
    case 'starting-server':
      statusBarItem.text = '$(loading~spin) Grafema: starting...';
      statusBarItem.tooltip = 'Grafema: Starting RFDB server';
      break;
    case 'error':
      statusBarItem.text = '$(error) Grafema: disconnected';
      statusBarItem.tooltip = `Grafema: ${state.message}`;
      break;
    case 'no-database':
      statusBarItem.text = '$(circle-large-outline) Grafema: no database';
      statusBarItem.tooltip = 'Grafema: Run `grafema analyze` first';
      break;
    default:
      statusBarItem.text = '$(circle-large-outline) Grafema';
      statusBarItem.tooltip = 'Grafema: Disconnected';
      break;
  }
}

/**
 * Map node type to VS Code icon name (for QuickPick labels)
 */
function getIconName(nodeType: string): string {
  const map: Record<string, string> = {
    FUNCTION: 'function',
    METHOD: 'method',
    CLASS: 'class',
    VARIABLE: 'variable',
    PARAMETER: 'parameter',
    CONSTANT: 'constant',
    MODULE: 'module',
    IMPORT: 'package',
    EXPORT: 'event',
    FILE: 'file',
  };
  return map[nodeType] || 'misc';
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
