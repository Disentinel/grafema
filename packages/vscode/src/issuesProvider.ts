/**
 * Issues Provider -- TreeDataProvider for the ISSUES panel.
 *
 * Shows issue nodes from the graph grouped by severity:
 *   - Violations: error-severity issues
 *   - Connectivity: issue:connectivity nodes
 *   - Warnings: warning/info-severity issues (non-connectivity)
 *
 * Supports badge count on the panel tab and populates
 * VS Code's DiagnosticCollection (Problems panel) for
 * violations and error-severity connectivity issues.
 */

import * as vscode from 'vscode';
import type { WireNode } from '@grafema/types';
import type { GrafemaClientManager } from './grafemaClient';
import { parseNodeMetadata } from './types';
import type { IssueItem, IssueSectionKind, NodeMetadata } from './types';

/** Known issue categories for targeted queries */
const KNOWN_ISSUE_CATEGORIES = ['security', 'performance', 'style', 'smell', 'connectivity'] as const;

/**
 * Get the appropriate ThemeIcon for an issue item based on its section and metadata.
 */
function getSeverityIcon(sectionKind: IssueSectionKind, metadata: NodeMetadata): vscode.ThemeIcon {
  if (sectionKind === 'violation') return new vscode.ThemeIcon('error');
  if (sectionKind === 'connectivity') return new vscode.ThemeIcon('debug-disconnect');
  const severity = typeof metadata.severity === 'string' ? metadata.severity : undefined;
  if (severity === 'info') return new vscode.ThemeIcon('info');
  return new vscode.ThemeIcon('warning');
}

/**
 * Build short description for an issue tree item.
 * Format: "src/auth.js:42" (file:line if available, file only otherwise, empty if neither).
 */
function buildIssueDescription(node: WireNode, metadata: NodeMetadata): string {
  const file = node.file ?? '';
  if (!file) return '';
  if (metadata.line !== undefined) return `${file}:${metadata.line}`;
  return file;
}

/**
 * Build multi-line tooltip for an issue tree item.
 */
function buildIssueTooltip(node: WireNode, metadata: NodeMetadata): string {
  const severity = typeof metadata.severity === 'string' ? metadata.severity : 'unknown';
  const plugin = typeof metadata.plugin === 'string' ? metadata.plugin : 'unknown';
  const lines = [
    `Type: ${node.nodeType}`,
    `Message: ${node.name}`,
    `File: ${node.file ?? '(unknown)'}`,
  ];
  if (metadata.line !== undefined) {
    lines.push(`Line: ${metadata.line}`);
  }
  lines.push(`Severity: ${severity}`);
  lines.push(`Plugin: ${plugin}`);
  return lines.join('\n');
}

/**
 * Map severity string to VS Code DiagnosticSeverity.
 * Returns Warning for unknown/undefined severity values.
 */
function mapDiagnosticSeverity(severity: string | undefined): vscode.DiagnosticSeverity {
  if (severity === 'error') return vscode.DiagnosticSeverity.Error;
  if (severity === 'info') return vscode.DiagnosticSeverity.Information;
  return vscode.DiagnosticSeverity.Warning;
}

export class IssuesProvider implements vscode.TreeDataProvider<IssueItem> {
  private _onDidChangeTreeData =
    new vscode.EventEmitter<IssueItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private violations: WireNode[] | null = null;
  private connectivity: WireNode[] | null = null;
  private warnings: WireNode[] | null = null;

  private treeView: vscode.TreeView<IssueItem> | null = null;
  private diagnosticCollection: vscode.DiagnosticCollection | null = null;
  private workspaceRoot: string | undefined;

  constructor(private clientManager: GrafemaClientManager, workspaceRoot?: string) {
    this.workspaceRoot = workspaceRoot;
    clientManager.on('reconnected', () => {
      this.violations = null;
      this.connectivity = null;
      this.warnings = null;
      this._onDidChangeTreeData.fire();
    });
  }

  /**
   * Store TreeView reference for badge updates.
   * Called by extension.ts after createTreeView.
   */
  setTreeView(view: vscode.TreeView<IssueItem>): void {
    this.treeView = view;
  }

  /**
   * Store DiagnosticCollection reference for Problems panel population.
   * Called by extension.ts after createDiagnosticCollection.
   */
  setDiagnosticCollection(collection: vscode.DiagnosticCollection): void {
    this.diagnosticCollection = collection;
  }

  /**
   * Clear cache and trigger re-fetch on next getChildren call.
   */
  refresh(): void {
    this.violations = null;
    this.connectivity = null;
    this.warnings = null;
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: IssueItem): vscode.TreeItem {
    switch (element.kind) {
      case 'section': {
        const item = new vscode.TreeItem(
          element.label,
          vscode.TreeItemCollapsibleState.Expanded
        );
        item.iconPath = new vscode.ThemeIcon(element.icon);
        item.description = String(element.count);
        return item;
      }

      case 'issue': {
        const item = new vscode.TreeItem(
          element.node.name,
          vscode.TreeItemCollapsibleState.None
        );
        item.iconPath = getSeverityIcon(element.sectionKind, element.metadata);
        item.description = buildIssueDescription(element.node, element.metadata);
        item.tooltip = buildIssueTooltip(element.node, element.metadata);
        item.contextValue = 'grafemaIssue';

        if (element.metadata.line !== undefined && element.node.file) {
          item.command = {
            command: 'grafema.gotoLocation',
            title: 'Go to Location',
            arguments: [element.node.file, element.metadata.line, element.metadata.column ?? 0],
          };
        }

        return item;
      }

      case 'status': {
        const item = new vscode.TreeItem(
          element.message,
          vscode.TreeItemCollapsibleState.None
        );
        item.iconPath = new vscode.ThemeIcon('info');
        return item;
      }

      default:
        return new vscode.TreeItem('Unknown item');
    }
  }

  async getChildren(element?: IssueItem): Promise<IssueItem[]> {
    if (!element) {
      if (!this.clientManager.isConnected()) {
        return [{ kind: 'status', message: 'Not connected to graph.' }];
      }

      if (this.violations === null) {
        await this.loadIssues();
      }

      const violations = this.violations ?? [];
      const connectivity = this.connectivity ?? [];
      const warnings = this.warnings ?? [];

      if (violations.length === 0 && connectivity.length === 0 && warnings.length === 0) {
        return [{ kind: 'status', message: 'No issues found.' }];
      }

      const sections: IssueItem[] = [];
      if (violations.length > 0) {
        sections.push({ kind: 'section', label: 'Violations', icon: 'error', sectionKind: 'violation', count: violations.length });
      }
      if (connectivity.length > 0) {
        sections.push({ kind: 'section', label: 'Connectivity', icon: 'debug-disconnect', sectionKind: 'connectivity', count: connectivity.length });
      }
      if (warnings.length > 0) {
        sections.push({ kind: 'section', label: 'Warnings', icon: 'warning', sectionKind: 'warning', count: warnings.length });
      }
      return sections;
    }

    if (element.kind === 'section') {
      // Guard against null when section expanded before load completes
      const arr = element.sectionKind === 'violation' ? this.violations
        : element.sectionKind === 'connectivity' ? this.connectivity
          : this.warnings;
      return (arr ?? []).map((node) => ({
        kind: 'issue' as const,
        node,
        metadata: parseNodeMetadata(node),
        sectionKind: element.sectionKind,
      }));
    }

    return [];
  }

  getParent(_element: IssueItem): null {
    return null;
  }

  /**
   * Fetch all issue nodes, classify into buckets, update badge and diagnostics.
   */
  private async loadIssues(): Promise<void> {
    if (!this.clientManager.isConnected()) {
      this.violations = [];
      this.connectivity = [];
      this.warnings = [];
      return;
    }

    const allIssues = await this.fetchAllIssueNodes();

    const violations: WireNode[] = [];
    const connectivity: WireNode[] = [];
    const warnings: WireNode[] = [];

    for (const node of allIssues) {
      if (node.nodeType === 'issue:connectivity') {
        connectivity.push(node);
        continue;
      }
      const meta = parseNodeMetadata(node);
      const severity = typeof meta.severity === 'string' ? meta.severity : undefined;
      if (severity === 'error') {
        violations.push(node);
      } else {
        warnings.push(node);
      }
    }

    this.violations = violations;
    this.connectivity = connectivity;
    this.warnings = warnings;
    this.updateBadge();
    this.updateDiagnostics();
  }

  /**
   * Two-pass query: known categories via queryNodes, unknown via getAllNodes fallback.
   */
  private async fetchAllIssueNodes(): Promise<WireNode[]> {
    try {
      const client = this.clientManager.getClient();
      const counts = await client.countNodesByType();

      const activeTypes: string[] = [];
      for (const key of Object.keys(counts)) {
        if (key.startsWith('issue:') && counts[key] > 0) {
          activeTypes.push(key);
        }
      }

      if (activeTypes.length === 0) return [];

      const knownCategories = new Set<string>(
        KNOWN_ISSUE_CATEGORIES.map((c) => `issue:${c}`)
      );
      const knownTypes = activeTypes.filter((t) => knownCategories.has(t));
      const unknownTypes = activeTypes.filter((t) => !knownCategories.has(t));

      const nodeMap = new Map<string, WireNode>();

      // Pass 1: query known categories in parallel
      const knownPromises = knownTypes.map(async (nodeType) => {
        const nodes: WireNode[] = [];
        for await (const node of client.queryNodes({ nodeType })) {
          nodes.push(node);
        }
        return nodes;
      });
      const knownResults = await Promise.all(knownPromises);
      for (const batch of knownResults) {
        for (const node of batch) {
          nodeMap.set(node.id, node);
        }
      }

      // Pass 2: unknown categories via getAllNodes fallback
      if (unknownTypes.length > 0) {
        const unknownSet = new Set(unknownTypes);
        const allNodes = await client.getAllNodes({});
        for (const node of allNodes) {
          if (unknownSet.has(node.nodeType)) {
            nodeMap.set(node.id, node);
          }
        }
      }

      return Array.from(nodeMap.values());
    } catch (err) {
      console.error('[grafema-issues] Error fetching issue nodes:', err);
      return [];
    }
  }

  /**
   * Update the panel tab badge with total issue count.
   */
  private updateBadge(): void {
    if (!this.treeView) return;
    const total = (this.violations?.length ?? 0)
      + (this.connectivity?.length ?? 0)
      + (this.warnings?.length ?? 0);
    if (total === 0) {
      this.treeView.badge = undefined;
    } else {
      this.treeView.badge = {
        value: total,
        tooltip: `${total} issue${total === 1 ? '' : 's'} in graph`,
      };
    }
  }

  /**
   * Populate DiagnosticCollection for violations and error-severity connectivity issues.
   * Violations bucket always uses DiagnosticSeverity.Error.
   * Skips diagnostics when path would be non-absolute (no workspace root).
   */
  private updateDiagnostics(): void {
    if (!this.diagnosticCollection) return;
    this.diagnosticCollection.clear();

    const diagMap = new Map<string, { uri: vscode.Uri; diagnostics: vscode.Diagnostic[] }>();

    // Collect nodes for diagnostics: all violations + error-severity connectivity
    const diagnosticNodes: Array<{ node: WireNode; forceError: boolean }> = [];
    for (const node of this.violations ?? []) {
      diagnosticNodes.push({ node, forceError: true });
    }
    for (const node of this.connectivity ?? []) {
      const meta = parseNodeMetadata(node);
      const severity = typeof meta.severity === 'string' ? meta.severity : undefined;
      if (severity === 'error') {
        diagnosticNodes.push({ node, forceError: false });
      }
    }

    for (const { node, forceError } of diagnosticNodes) {
      if (!node.file) continue;
      const meta = parseNodeMetadata(node);
      if (meta.line === undefined) continue;

      const absPath = this.workspaceRoot && !node.file.startsWith('/')
        ? `${this.workspaceRoot}/${node.file}`
        : node.file;

      // Skip if path is non-absolute (no workspace root for relative path)
      if (!absPath.startsWith('/')) continue;

      const uri = vscode.Uri.file(absPath);
      const uriStr = uri.toString();
      const line = Math.max(0, meta.line - 1);
      const column = meta.column ?? 0;
      const range = new vscode.Range(line, column, line, column + 100);

      const severity = typeof meta.severity === 'string' ? meta.severity : undefined;
      const diagSeverity = forceError
        ? vscode.DiagnosticSeverity.Error
        : mapDiagnosticSeverity(severity);

      const diag = new vscode.Diagnostic(range, node.name, diagSeverity);
      diag.source = 'Grafema';
      diag.code = node.nodeType;

      const entry = diagMap.get(uriStr);
      if (entry) {
        entry.diagnostics.push(diag);
      } else {
        diagMap.set(uriStr, { uri, diagnostics: [diag] });
      }
    }

    for (const { uri, diagnostics } of diagMap.values()) {
      this.diagnosticCollection.set(uri, diagnostics);
    }
  }
}
