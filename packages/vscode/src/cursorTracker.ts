/**
 * Cursor Tracker — manages cursor-follow state for Explorer panel.
 *
 * Extracted from extension.ts to reduce file size.
 * Handles finding graph nodes at the current cursor position
 * and updating the Explorer tree root accordingly.
 */

import * as vscode from 'vscode';
import type { GrafemaClientManager } from './grafemaClient';
import type { EdgesProvider } from './edgesProvider';
import type { DebugProvider } from './debugProvider';
import { findNodeAtCursor } from './nodeLocator';

/**
 * Find node at current cursor position and set as root in the Explorer panel.
 *
 * @param clientManager - RFDB client connection manager
 * @param edgesProvider - Explorer tree data provider
 * @param debugProvider - Debug log provider (for diagnostic entries)
 * @param preserveHistory - If true, pushes to navigation history; if false, clears path
 */
export async function findAndSetRoot(
  clientManager: GrafemaClientManager | null,
  edgesProvider: EdgesProvider | null,
  debugProvider: DebugProvider | null,
  preserveHistory: boolean
): Promise<void> {
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
 * Update status bar to show connection state + follow mode in tooltip.
 *
 * @param statusBarItem - VS Code status bar item to update
 * @param clientManager - RFDB client connection manager
 * @param followCursor - Whether follow-cursor mode is enabled
 */
export function updateStatusBar(
  statusBarItem: vscode.StatusBarItem | null,
  clientManager: GrafemaClientManager | null,
  followCursor: boolean
): void {
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
