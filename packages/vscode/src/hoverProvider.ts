/**
 * Grafema Hover Provider — shows value trace origins on hover.
 *
 * Activation: Mouse hovers over a variable/parameter/constant in JS/TS code.
 * Result: Markdown card showing backward trace origins.
 *
 * No additional debounce needed — VSCode's hover mechanism debounces natively
 * (300ms default). CancellationToken handles user moving away mid-query.
 */

import * as vscode from 'vscode';
import type { WireNode } from '@grafema/types';
import type { GrafemaClientManager } from './grafemaClient';
import { findNodeAtCursor } from './nodeLocator';
import { traceBackward } from './traceEngine';
import type { TraceNode } from './types';

/** Depth for hover backward trace — 3 levels is sufficient for hover context */
const HOVER_DEPTH = 3;

export class GrafemaHoverProvider implements vscode.HoverProvider {
  constructor(private clientManager: GrafemaClientManager) {}

  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): Promise<vscode.Hover | null> {
    if (document.uri.scheme !== 'file') return null;
    if (!this.clientManager.isConnected()) return null;

    try {
      const client = this.clientManager.getClient();

      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const absPath = document.uri.fsPath;
      const filePath = workspaceRoot && absPath.startsWith(workspaceRoot)
        ? absPath.slice(workspaceRoot.length + 1)
        : absPath;

      const line = position.line + 1;
      const column = position.character;

      const node = await findNodeAtCursor(client, filePath, line, column);
      if (token.isCancellationRequested) return null;
      if (!node) return null;

      if (isStructuralNode(node)) return null;

      const { nodes: origins } = await traceBackward(client, node.id, HOVER_DEPTH, token);
      if (token.isCancellationRequested) return null;

      const markdown = buildHoverMarkdown(node, origins);
      return new vscode.Hover(markdown);
    } catch {
      // Silent fail — hover must never show an error popup
      return null;
    }
  }
}

/**
 * Nodes that don't make sense for value trace hover.
 * These are structural/control-flow nodes, not value-carrying nodes.
 */
export function isStructuralNode(node: WireNode): boolean {
  const skipTypes = new Set([
    'MODULE', 'FILE', 'SCOPE', 'BRANCH', 'LOOP', 'PROJECT', 'SERVICE',
    'IMPORT', 'EXPORT', 'TRY_BLOCK', 'CATCH_BLOCK', 'FINALLY_BLOCK',
    'CASE', 'EXTERNAL', 'EXTERNAL_MODULE',
  ]);
  const nodeType = node.nodeType;
  return skipTypes.has(nodeType);
}

/**
 * Build the hover MarkdownString for a root node and its origins.
 *
 * Format:
 *   **GRAFEMA** -- Value origins for `varName`
 *
 *   <- `origin1`  file.ts:18  (user input)
 *     <- `origin2`  file.ts:5  (literal)
 *   <- `origin3`  file.ts:32
 *
 *   [Open in VALUE TRACE panel](command:grafema.openValueTrace)
 */
export function buildHoverMarkdown(
  root: WireNode,
  origins: TraceNode[],
  MdCtor?: new (value?: string, supportThemeIcons?: boolean) => vscode.MarkdownString,
): vscode.MarkdownString {
  const Ctor = MdCtor ?? vscode.MarkdownString;
  const md = new Ctor('', true);
  md.isTrusted = true;
  md.supportHtml = false;

  const nodeName = root.name ?? root.nodeType ?? 'unknown';
  md.appendMarkdown(`**GRAFEMA** \u00b7 Value origins for \`${nodeName}\`\n\n`);

  if (origins.length === 0) {
    md.appendMarkdown('*No value origins found in graph.*\n');
    md.appendMarkdown('*Run `grafema analyze` to refresh the graph.*\n\n');
  } else {
    for (const origin of origins) {
      renderOriginLine(md, origin, 0);
    }
    md.appendMarkdown('\n');
  }

  md.appendMarkdown(`[Open in VALUE TRACE panel](command:grafema.openValueTrace)`);
  return md;
}

/**
 * Render one origin line in the hover markdown, indented by depth.
 * Recursively renders children.
 */
function renderOriginLine(md: vscode.MarkdownString, origin: TraceNode, indent: number): void {
  const prefix = '  '.repeat(indent) + '\u2190 ';
  const name = origin.node.name ?? origin.node.nodeType ?? 'unknown';
  const file = origin.node.file ?? '';
  const line = origin.metadata.line;
  const location = line ? `${file}:${line}` : file;

  const annotations: string[] = [];
  if (origin.sourceKind && origin.sourceKind !== 'unknown') {
    annotations.push(origin.sourceKind.replace('-', ' '));
  }
  const annotation = annotations.length > 0 ? `  *(${annotations.join(', ')})*` : '';

  md.appendMarkdown(`${prefix}\`${name}\`  *${location}*${annotation}\n`);

  if (indent < 2) {
    for (const child of origin.children) {
      renderOriginLine(md, child, indent + 1);
    }
  }
}
