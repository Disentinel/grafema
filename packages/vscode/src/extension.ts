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
import { debounce, getIconName } from './utils';
import { buildTreeState } from './treeStateExporter';
import { findAndSetRoot, updateStatusBar } from './cursorTracker';
import { ValueTraceProvider } from './valueTraceProvider';
import { GrafemaHoverProvider } from './hoverProvider';
import { CallersProvider } from './callersProvider';
import { IssuesProvider } from './issuesProvider';
import { BlastRadiusProvider } from './blastRadiusProvider';
import { GrafemaCodeLensProvider } from './codeLensProvider';

let clientManager: GrafemaClientManager | null = null;
let edgesProvider: EdgesProvider | null = null;
let statusProvider: StatusProvider | null = null;
let debugProvider: DebugProvider | null = null;
let treeView: vscode.TreeView<GraphTreeItem> | null = null;
let followCursor = true; // Follow cursor mode (toggle with cmd+shift+g)
let statusBarItem: vscode.StatusBarItem | null = null;
let selectedTreeItem: GraphTreeItem | null = null; // Track selected item for state export
let valueTraceProvider: ValueTraceProvider | null = null;
let callersProvider: CallersProvider | null = null;
let issuesProvider: IssuesProvider | null = null;
let blastRadiusProvider: BlastRadiusProvider | null = null;

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

  // Initialize tree provider (pass context for workspaceState persistence)
  edgesProvider = new EdgesProvider(clientManager, context);

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

  // Register VALUE TRACE provider
  valueTraceProvider = new ValueTraceProvider(clientManager);
  const valueTraceRegistration = vscode.window.registerTreeDataProvider(
    'grafemaValueTrace',
    valueTraceProvider
  );

  // Register Hover Provider (JS/TS files only)
  const hoverProvider = new GrafemaHoverProvider(clientManager);
  const hoverDisposable = vscode.languages.registerHoverProvider(
    [
      { scheme: 'file', language: 'javascript' },
      { scheme: 'file', language: 'typescript' },
      { scheme: 'file', language: 'javascriptreact' },
      { scheme: 'file', language: 'typescriptreact' },
    ],
    hoverProvider
  );

  // Register CALLERS panel provider
  callersProvider = new CallersProvider(clientManager);
  const callersRegistration = vscode.window.registerTreeDataProvider(
    'grafemaCallers',
    callersProvider
  );

  // Register ISSUES panel provider
  issuesProvider = new IssuesProvider(clientManager, workspaceRoot);
  const issuesView = vscode.window.createTreeView('grafemaIssues', {
    treeDataProvider: issuesProvider,
  });
  issuesProvider.setTreeView(issuesView);

  const diagnosticCollection = vscode.languages.createDiagnosticCollection('grafema');
  issuesProvider.setDiagnosticCollection(diagnosticCollection);

  // Register BLAST RADIUS panel provider (Pattern B: createTreeView)
  blastRadiusProvider = new BlastRadiusProvider(clientManager);
  const blastRadiusView = vscode.window.createTreeView('grafemaBlastRadius', {
    treeDataProvider: blastRadiusProvider,
  });
  blastRadiusProvider.setTreeView(blastRadiusView);

  // Register CodeLens provider (JS/TS files only)
  const codeLensProvider = new GrafemaCodeLensProvider(clientManager);
  const codeLensDisposable = vscode.languages.registerCodeLensProvider(
    [
      { scheme: 'file', language: 'javascript' },
      { scheme: 'file', language: 'typescript' },
      { scheme: 'file', language: 'javascriptreact' },
      { scheme: 'file', language: 'typescriptreact' },
    ],
    codeLensProvider
  );

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
    updateStatusBar(statusBarItem, clientManager, followCursor);
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
    valueTraceRegistration,
    callersRegistration,
    issuesView,
    blastRadiusView,
    diagnosticCollection,
    codeLensDisposable,
    hoverDisposable,
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

  // Search nodes in graph
  disposables.push(vscode.commands.registerCommand('grafema.searchNodes', () => {
    openSearchNodes(clientManager, edgesProvider, debugProvider);
  }));

  // Find node at cursor and set as root (clears history)
  disposables.push(vscode.commands.registerCommand('grafema.findAtCursor', async () => {
    console.log('[grafema-explore] findAtCursor command fired');
    await findAndSetRoot(clientManager, edgesProvider, debugProvider, false);
  }));

  // Set selected tree item as new root (preserves history)
  disposables.push(vscode.commands.registerCommand(
    'grafema.setAsRoot',
    async (item: GraphTreeItem) => {
      if (!edgesProvider) return;

      let node: WireNode | null = null;

      if (item.kind === 'node') {
        node = item.node;
      } else if (item.kind === 'bookmark') {
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
    updateStatusBar(statusBarItem, clientManager, followCursor);
    if (followCursor) {
      findAndSetRoot(clientManager, edgesProvider, debugProvider, false);
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

  // Open VALUE TRACE panel at current cursor (called from hover command link)
  disposables.push(vscode.commands.registerCommand('grafema.openValueTrace', async () => {
    await vscode.commands.executeCommand('grafemaValueTrace.focus');
    if (valueTraceProvider && clientManager?.isConnected()) {
      await findAndTraceAtCursor();
    }
  }));

  // Toggle trace direction: both -> backward -> forward -> both
  disposables.push(vscode.commands.registerCommand('grafema.toggleValueTraceDirection', () => {
    valueTraceProvider?.cycleDirection();
  }));

  // Refresh VALUE TRACE (clears cache and re-traces current cursor)
  disposables.push(vscode.commands.registerCommand('grafema.refreshValueTrace', async () => {
    valueTraceProvider?.refresh();
    await findAndTraceAtCursor();
  }));

  // Open CALLERS panel — B4: uses nodeId+direction from args when provided
  disposables.push(vscode.commands.registerCommand(
    'grafema.openCallers',
    async (nodeId?: string, _filePath?: string, lensType?: string) => {
      await vscode.commands.executeCommand('grafemaCallers.focus');
      if (nodeId && clientManager?.isConnected()) {
        try {
          const node = await clientManager.getClient().getNode(nodeId);
          if (node) {
            callersProvider?.setRootNode(node);
            if (lensType === 'callers') {
              callersProvider?.setDirection('incoming');
            } else if (lensType === 'callees') {
              callersProvider?.setDirection('outgoing');
            }
          }
        } catch {
          // Fallback to cursor
          await findAndSetCallersAtCursor();
        }
      } else {
        await findAndSetCallersAtCursor();
      }
    }
  ));

  // Set max depth for CALLERS panel via Quick Pick
  disposables.push(vscode.commands.registerCommand('grafema.setCallersDepth', async () => {
    const currentDepth = callersProvider?.getMaxDepth() ?? 3;
    const items = ['1', '2', '3', '4', '5'].map((d) => ({
      label: d,
      description: d === String(currentDepth) ? '(current)' : '',
    }));
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Max call hierarchy depth',
    });
    if (picked) {
      callersProvider?.setMaxDepth(parseInt(picked.label, 10));
    }
  }));

  // Toggle CALLERS panel filters via Quick Pick
  disposables.push(vscode.commands.registerCommand('grafema.toggleCallersFilter', async () => {
    if (!callersProvider) return;
    const items: vscode.QuickPickItem[] = [
      {
        label: 'Hide test files',
        picked: callersProvider.getHideTestFiles(),
      },
      {
        label: 'Hide node_modules',
        picked: callersProvider.getHideNodeModules(),
      },
    ];
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Toggle callers filters',
      canPickMany: true,
    });
    if (picked) {
      callersProvider.setHideTestFiles(picked.some((p) => p.label === 'Hide test files'));
      callersProvider.setHideNodeModules(picked.some((p) => p.label === 'Hide node_modules'));
    }
  }));

  // Toggle CALLERS direction: both -> incoming -> outgoing -> both
  disposables.push(vscode.commands.registerCommand('grafema.toggleCallersDirection', () => {
    callersProvider?.cycleDirection();
  }));

  // Refresh CALLERS panel
  disposables.push(vscode.commands.registerCommand('grafema.refreshCallers', () => {
    callersProvider?.refresh();
  }));

  // Refresh ISSUES panel
  disposables.push(vscode.commands.registerCommand('grafema.refreshIssues', () => {
    issuesProvider?.refresh();
  }));

  // Open BLAST RADIUS panel — accepts optional nodeId from CodeLens
  disposables.push(vscode.commands.registerCommand(
    'grafema.openBlastRadius',
    async (nodeId?: string) => {
      await vscode.commands.executeCommand('grafemaBlastRadius.focus');
      if (nodeId && clientManager?.isConnected()) {
        try {
          const node = await clientManager.getClient().getNode(nodeId);
          if (node) {
            blastRadiusProvider?.setRootNode(node);
          }
        } catch {
          // Fallback to cursor
          await findAndSetBlastRadiusAtCursor();
        }
      } else {
        await findAndSetBlastRadiusAtCursor();
      }
    }
  ));

  // Refresh BLAST RADIUS panel
  disposables.push(vscode.commands.registerCommand('grafema.refreshBlastRadius', () => {
    blastRadiusProvider?.refresh();
  }));

  // Filter edge types in EXPLORER panel
  const COMMON_EDGE_TYPES = [
    'CALLS', 'IMPORTS', 'IMPORTS_FROM', 'EXPORTS', 'EXPORTS_TO',
    'ASSIGNED_FROM', 'DERIVES_FROM', 'CONTAINS', 'DEFINES', 'USES',
    'PASSES_ARGUMENT', 'RETURNS', 'EXTENDS', 'IMPLEMENTS',
  ];

  disposables.push(vscode.commands.registerCommand('grafema.filterEdgeTypes', async () => {
    if (!edgesProvider) return;

    const hidden = edgesProvider.getHiddenEdgeTypes();
    const items: vscode.QuickPickItem[] = COMMON_EDGE_TYPES.map((t) => ({
      label: t,
      picked: !hidden.has(t),
    }));

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select edge types to show (checked = visible)',
      canPickMany: true,
    });

    if (!picked) return; // cancelled

    if (picked.length === 0) {
      vscode.window.showInformationMessage('No edge types selected. Filter unchanged.');
      return;
    }

    const pickedLabels = new Set(picked.map((p) => p.label));
    const newHidden = new Set<string>();
    for (const t of COMMON_EDGE_TYPES) {
      if (!pickedLabels.has(t)) newHidden.add(t);
    }
    edgesProvider.setHiddenEdgeTypes(newHidden);
  }));

  // Bookmark node from tree context menu
  disposables.push(vscode.commands.registerCommand(
    'grafema.bookmarkNode',
    (item: GraphTreeItem) => {
      if (!edgesProvider) return;
      if (item.kind === 'node') {
        edgesProvider.addBookmark(item.node);
      }
    }
  ));

  // Remove bookmark from tree context menu
  disposables.push(vscode.commands.registerCommand(
    'grafema.removeBookmark',
    (item: GraphTreeItem) => {
      if (!edgesProvider) return;
      if (item.kind === 'bookmark') {
        edgesProvider.removeBookmark(item.node.id);
      }
    }
  ));

  // Clear all bookmarks
  disposables.push(vscode.commands.registerCommand('grafema.clearBookmarks', () => {
    edgesProvider?.clearBookmarks();
  }));

  // Status bar — click focuses STATUS view
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'grafema.focusStatus';
  updateStatusBar(statusBarItem, clientManager, followCursor);
  statusBarItem.show();
  disposables.push(statusBarItem);

  // Follow cursor on selection change
  disposables.push(vscode.window.onDidChangeTextEditorSelection(
    debounce(async (_event: vscode.TextEditorSelectionChangeEvent) => {
      console.log(`[grafema-explore] selection changed, followCursor=${followCursor}, connected=${clientManager?.isConnected()}`);
      if (followCursor && clientManager?.isConnected()) {
        await findAndSetRoot(clientManager, edgesProvider, debugProvider, false);
        await findAndTraceAtCursor();
        await findAndSetCallersAtCursor();
        await findAndSetBlastRadiusAtCursor();
      }
    }, 150)
  ));

  return disposables;
}

/**
 * Resolve the graph node at the current cursor position.
 * Shared helper that eliminates the repeated editor/path/cursor boilerplate
 * from findAndTraceAtCursor, findAndSetCallersAtCursor, and findAndSetBlastRadiusAtCursor.
 *
 * Returns null if no active file editor, not connected, or no node found.
 */
async function resolveNodeAtCursor(): Promise<WireNode | null> {
  if (!clientManager?.isConnected()) return null;

  const editor = vscode.window.activeTextEditor;
  if (!editor) return null;
  if (editor.document.uri.scheme !== 'file') return null;

  const position = editor.selection.active;
  const absPath = editor.document.uri.fsPath;
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const filePath = workspaceRoot && absPath.startsWith(workspaceRoot)
    ? absPath.slice(workspaceRoot.length + 1)
    : absPath;

  try {
    const client = clientManager.getClient();
    return await findNodeAtCursor(client, filePath, position.line + 1, position.character);
  } catch {
    return null;
  }
}

/**
 * Find node at current cursor and trigger VALUE TRACE panel update.
 * Parallel to findAndSetRoot() but for the VALUE TRACE panel.
 */
async function findAndTraceAtCursor(): Promise<void> {
  if (!valueTraceProvider) return;
  const node = await resolveNodeAtCursor();
  if (node) {
    await valueTraceProvider.traceNode(node);
  }
}

/**
 * Find node at current cursor and update CALLERS panel if on a function.
 * Only sets root when cursor is on a FUNCTION or METHOD node.
 */
async function findAndSetCallersAtCursor(): Promise<void> {
  if (!callersProvider) return;
  const node = await resolveNodeAtCursor();
  if (node && (node.nodeType === 'FUNCTION' || node.nodeType === 'METHOD')) {
    callersProvider.setRootNode(node);
  }
}

/**
 * Find node at current cursor and update BLAST RADIUS panel.
 * Triggers on FUNCTION, METHOD, VARIABLE, and CONSTANT node types.
 */
async function findAndSetBlastRadiusAtCursor(): Promise<void> {
  if (!blastRadiusProvider) return;
  const node = await resolveNodeAtCursor();
  if (node && (
    node.nodeType === 'FUNCTION'
    || node.nodeType === 'METHOD'
    || node.nodeType === 'VARIABLE'
    || node.nodeType === 'CONSTANT'
  )) {
    blastRadiusProvider.setRootNode(node);
  }
}

/**
 * Search nodes in graph — streaming search with timeout.
 * Opens a QuickPick with debounced streaming search against RFDB.
 */
function openSearchNodes(
  cm: GrafemaClientManager | null,
  ep: EdgesProvider | null,
  dp: DebugProvider | null
): void {
  if (!cm?.isConnected() || !ep) {
    vscode.window.showWarningMessage('Grafema: Not connected to graph');
    return;
  }

  const SEARCH_TIMEOUT_MS = 5000;
  const SEARCH_MAX_RESULTS = 50;

  const client = cm.getClient();

  const quickPick = vscode.window.createQuickPick();
  quickPick.placeholder = 'Search: exact name, or TYPE:substring (e.g. FUNCTION:handle, MODULE:)';
  quickPick.matchOnDescription = true;

  const nodeIdMap = new Map<string, string>(); // detail display text -> numeric id
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

      // Build RFDB query -- use exact match fields where possible
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

        // Stream results -- collect up to SEARCH_MAX_RESULTS
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
        dp?.log({
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
            const exportedTag = node.exported ? ' [exported]' : '';
            const displayId = node.semanticId || node.id;
            nodeIdMap.set(displayId, node.id);
            items.push({
              label: `$(symbol-${getIconName(node.nodeType)}) ${node.nodeType} "${node.name}"`,
              description: `${node.file}${loc}${exportedTag}`,
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
        dp?.log({
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
    if (selected?.detail && cm?.isConnected()) {
      const nodeId = nodeIdMap.get(selected.detail) || selected.detail;
      cm.getClient().getNode(nodeId).then((node) => {
        if (node && ep) {
          ep.navigateToNode(node);
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
}

/**
 * Extension deactivation
 */
export function deactivate(): void {
  console.log('[grafema-explore] Deactivating extension');
  clientManager?.disconnect();
}
