/**
 * Grafema CodeLens Provider -- shows caller/callee counts above functions.
 *
 * Two-phase approach:
 *   1. provideCodeLenses: returns placeholder lenses (cold) or resolved lenses (warm cache)
 *   2. resolveCodeLens: reads from cache if available
 *
 * Background batch fetch populates cache and fires onDidChangeCodeLenses
 * to trigger re-resolution with real counts.
 */

import * as vscode from 'vscode';
import type { WireNode } from '@grafema/types';
import type { GrafemaClientManager } from './grafemaClient';
import { parseNodeMetadata } from './types';

/** Edge type for call counting */
const CALLS_EDGE_TYPES = ['CALLS'] as const;

/**
 * Cached counts for a single function node.
 */
interface FunctionCounts {
  callers: number;
  callees: number;
}

export class GrafemaCodeLensProvider implements vscode.CodeLensProvider {
  private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  /** Cache: filePath -> Map<nodeId, counts> */
  private cache: Map<string, Map<string, FunctionCounts>> = new Map();

  /** Set of file paths currently being batch-fetched */
  private inFlight: Set<string> = new Set();

  constructor(private clientManager: GrafemaClientManager) {
    clientManager.on('reconnected', () => {
      this.cache.clear();
      this.inFlight.clear();
      this._onDidChangeCodeLenses.fire();
    });
  }

  async provideCodeLenses(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken
  ): Promise<vscode.CodeLens[]> {
    if (!this.clientManager.isConnected()) {
      return [];
    }

    const config = vscode.workspace.getConfiguration('grafema');
    if (!config.get<boolean>('codeLens.enabled', true)) {
      return [];
    }

    const absPath = document.uri.fsPath;
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const filePath = workspaceRoot && absPath.startsWith(workspaceRoot)
      ? absPath.slice(workspaceRoot.length + 1)
      : absPath;

    let funcNodes: WireNode[];
    try {
      const client = this.clientManager.getClient();
      const fileNodes = await client.getAllNodes({ file: filePath });
      funcNodes = fileNodes.filter(
        (n) => n.nodeType === 'FUNCTION' || n.nodeType === 'METHOD'
      );
    } catch {
      return [];
    }

    if (funcNodes.length === 0) {
      return [];
    }

    const showBlast = config.get<boolean>('codeLens.showBlastRadius', false);
    const cachedFile = this.cache.get(filePath);

    // Warm path: cache populated, return resolved lenses
    if (cachedFile) {
      return this.buildResolvedLenses(funcNodes, cachedFile, filePath, showBlast);
    }

    // Cold path: launch batch fetch, return placeholder lenses
    if (!this.inFlight.has(filePath)) {
      this.batchFetchCounts(filePath, funcNodes);
    }

    return this.buildPlaceholderLenses(funcNodes, filePath, showBlast);
  }

  resolveCodeLens(
    codeLens: vscode.CodeLens,
    _token: vscode.CancellationToken
  ): vscode.CodeLens {
    // If already resolved (not a placeholder), return as-is
    if (codeLens.command && !codeLens.command.title.endsWith('...')) {
      return codeLens;
    }

    const nodeId = codeLens.command?.arguments?.[0] as string | undefined;
    const filePath = codeLens.command?.arguments?.[1] as string | undefined;
    const lensType = codeLens.command?.arguments?.[2] as string | undefined;
    if (!nodeId || !filePath || !lensType) {
      return codeLens;
    }

    const cached = this.cache.get(filePath)?.get(nodeId);
    if (!cached) {
      return codeLens;
    }

    codeLens.command = this.buildCommand(nodeId, filePath, lensType, cached);
    return codeLens;
  }

  /**
   * Build 3 placeholder lenses per function (B3: always 3, not 1).
   */
  private buildPlaceholderLenses(
    funcNodes: WireNode[],
    filePath: string,
    showBlast: boolean
  ): vscode.CodeLens[] {
    const lenses: vscode.CodeLens[] = [];

    for (const node of funcNodes) {
      const meta = parseNodeMetadata(node);
      if (meta.line === undefined) {
        continue;
      }
      const pos = new vscode.Position(Math.max(0, meta.line - 1), meta.column ?? 0);
      const range = new vscode.Range(pos, pos);

      // Lens 1: callers
      lenses.push(new vscode.CodeLens(range, {
        command: 'grafema.openCallers',
        title: 'callers: ...',
        arguments: [node.id, filePath, 'callers'],
      }));

      // Lens 2: callees
      lenses.push(new vscode.CodeLens(range, {
        command: 'grafema.openCallers',
        title: 'callees: ...',
        arguments: [node.id, filePath, 'callees'],
      }));

      // Lens 3: blast radius (only if enabled)
      if (showBlast) {
        lenses.push(new vscode.CodeLens(range, {
          command: 'grafema.openBlastRadius',
          title: 'blast: ?',
          arguments: [node.id, filePath, 'blast'],
        }));
      }
    }

    return lenses;
  }

  /**
   * Build 3 resolved lenses per function from cache.
   */
  private buildResolvedLenses(
    funcNodes: WireNode[],
    cachedFile: Map<string, FunctionCounts>,
    filePath: string,
    showBlast: boolean
  ): vscode.CodeLens[] {
    const lenses: vscode.CodeLens[] = [];

    for (const node of funcNodes) {
      const meta = parseNodeMetadata(node);
      if (meta.line === undefined) {
        continue;
      }
      const pos = new vscode.Position(Math.max(0, meta.line - 1), meta.column ?? 0);
      const range = new vscode.Range(pos, pos);

      const counts = cachedFile.get(node.id);
      if (!counts) {
        // Node not in cache yet -- show placeholder
        lenses.push(new vscode.CodeLens(range, {
          command: 'grafema.openCallers',
          title: 'callers: ...',
          arguments: [node.id, filePath, 'callers'],
        }));
        lenses.push(new vscode.CodeLens(range, {
          command: 'grafema.openCallers',
          title: 'callees: ...',
          arguments: [node.id, filePath, 'callees'],
        }));
        if (showBlast) {
          lenses.push(new vscode.CodeLens(range, {
            command: 'grafema.openBlastRadius',
            title: 'blast: ?',
            arguments: [node.id, filePath, 'blast'],
          }));
        }
        continue;
      }

      // Resolved lenses
      lenses.push(new vscode.CodeLens(range, this.buildCommand(node.id, filePath, 'callers', counts)));
      lenses.push(new vscode.CodeLens(range, this.buildCommand(node.id, filePath, 'callees', counts)));
      if (showBlast) {
        lenses.push(new vscode.CodeLens(range, {
          command: 'grafema.openBlastRadius',
          title: 'blast: ?',
          arguments: [node.id, filePath, 'blast'],
        }));
      }
    }

    return lenses;
  }

  /**
   * Build a resolved command for a lens.
   */
  private buildCommand(
    nodeId: string,
    filePath: string,
    lensType: string,
    counts: FunctionCounts
  ): vscode.Command {
    if (lensType === 'callers') {
      return {
        command: 'grafema.openCallers',
        title: `${counts.callers} callers`,
        arguments: [nodeId, filePath, 'callers'],
      };
    }
    if (lensType === 'callees') {
      return {
        command: 'grafema.openCallers',
        title: `${counts.callees} callees`,
        arguments: [nodeId, filePath, 'callees'],
      };
    }
    return {
      command: 'grafema.openBlastRadius',
      title: 'blast: ?',
      arguments: [nodeId, filePath, 'blast'],
    };
  }

  /**
   * Batch fetch caller/callee counts for all functions in a file.
   * Fire-and-forget -- updates cache and triggers re-render.
   */
  private async batchFetchCounts(filePath: string, funcNodes: WireNode[]): Promise<void> {
    this.inFlight.add(filePath);

    try {
      const client = this.clientManager.getClient();
      const counts = new Map<string, FunctionCounts>();

      await Promise.all(funcNodes.map(async (node) => {
        try {
          const [incoming, outgoing] = await Promise.all([
            client.getIncomingEdges(node.id, [...CALLS_EDGE_TYPES]),
            client.getOutgoingEdges(node.id, [...CALLS_EDGE_TYPES]),
          ]);
          counts.set(node.id, {
            callers: incoming.length,
            callees: outgoing.length,
          });
        } catch {
          counts.set(node.id, { callers: 0, callees: 0 });
        }
      }));

      this.cache.set(filePath, counts);
      this._onDidChangeCodeLenses.fire();
    } catch {
      // Silent fail -- lenses stay as placeholders
    } finally {
      this.inFlight.delete(filePath);
    }
  }
}
