/**
 * Map Panel — Webview panel showing the hex topology map.
 *
 * Embeds the GUI server's hex map visualization in a VS Code webview.
 * Auto-starts gui-server if not running. Shows loader during hex layout computation.
 * Communicates with the extension for node selection and trace visualization.
 */

import * as vscode from 'vscode';
import { spawn, type ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

const GUI_PORT = 3333;
const GUI_HOST = `http://localhost:${GUI_PORT}`;
let guiServerProcess: ChildProcess | null = null;

export class MapPanel {
  public static currentPanel: MapPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  private constructor(panel: vscode.WebviewPanel) {
    this.panel = panel;
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      (message) => {
        if (message.command === 'nodeSelected' && message.file) {
          const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          if (root) {
            const uri = vscode.Uri.file(join(root, message.file));
            const line = Math.max(0, (message.line || 1) - 1);
            vscode.window.showTextDocument(uri, {
              selection: new vscode.Range(line, 0, line, 0),
              preserveFocus: false,
            });
          }
        }
      },
      null,
      this.disposables
    );

    this.panel.webview.html = this.getLoaderHtml();
    this.ensureServerAndLoad();
  }

  public static createOrShow(): void {
    if (MapPanel.currentPanel) {
      MapPanel.currentPanel.panel.reveal(vscode.ViewColumn.Beside);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'grafemaMap',
      'Grafema Map',
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    MapPanel.currentPanel = new MapPanel(panel);
  }

  /** Send current cursor node to the map for highlighting. */
  public highlightNode(nodeName: string, nodeType: string): void {
    this.panel.webview.postMessage({ command: 'highlightNode', nodeName, nodeType });
  }

  /** Show a trace route on the map. */
  public showTrace(nodeNames: string[]): void {
    this.panel.webview.postMessage({ command: 'showTrace', nodeNames });
  }

  private async ensureServerAndLoad(): Promise<void> {
    // Check if server is already running
    try {
      const resp = await fetch(`${GUI_HOST}/api/stats`);
      if (resp.ok) {
        this.panel.webview.html = this.getMapHtml();
        return;
      }
    } catch {
      // Server not running — start it
    }

    this.panel.webview.html = this.getLoaderHtml('Starting GUI server...');
    await this.startGuiServer();

    // Poll until server is ready
    for (let i = 0; i < 120; i++) { // up to 60 seconds (layout computation)
      await new Promise(r => setTimeout(r, 500));
      try {
        const resp = await fetch(`${GUI_HOST}/api/stats`);
        if (resp.ok) {
          const data = await resp.json() as { nodeCount: number; tileCount: number };
          if (data.tileCount > 0) {
            this.panel.webview.html = this.getMapHtml();
            return;
          }
          this.panel.webview.html = this.getLoaderHtml(
            `Computing hex layout... ${data.nodeCount.toLocaleString()} nodes`
          );
        }
      } catch {
        // Still starting
      }
    }

    this.panel.webview.html = this.getLoaderHtml('GUI server failed to start. Check logs.');
  }

  private async startGuiServer(): Promise<void> {
    if (guiServerProcess) return;

    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return;

    // Find gui-server binary
    const candidates = [
      join(root, 'packages', 'gui-server', 'target', 'release', 'grafema-gui'),
      join(root, 'packages', 'gui-server', 'target', 'debug', 'grafema-gui'),
    ];
    const binary = candidates.find(p => existsSync(p));
    if (!binary) {
      vscode.window.showWarningMessage(
        'grafema-gui binary not found. Build with: cd packages/gui-server && cargo build --release'
      );
      return;
    }

    const socketPath = join(root, '.grafema', 'rfdb.sock');
    const staticDir = join(root, 'packages', 'gui', 'public');

    guiServerProcess = spawn(binary, [
      '--socket', socketPath,
      '--static-dir', staticDir,
      '--port', String(GUI_PORT),
    ], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });

    guiServerProcess.unref();
    guiServerProcess.on('exit', () => { guiServerProcess = null; });
    guiServerProcess.stderr?.on('data', (d: Buffer) => {
      console.log('[grafema-gui]', d.toString().trim());
    });
  }

  private getLoaderHtml(message = 'Connecting to GUI server...'): string {
    return `<!DOCTYPE html>
<html><head><style>
  body { background: #0a0e14; color: #00e5ff; font-family: 'SF Mono', monospace;
         display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
  .loader { text-align: center; }
  .spinner { width: 40px; height: 40px; border: 3px solid #00e5ff33; border-top-color: #00e5ff;
             border-radius: 50%; animation: spin 1s linear infinite; margin: 0 auto 16px; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .msg { font-size: 14px; opacity: 0.8; }
</style></head><body>
  <div class="loader"><div class="spinner"></div><div class="msg">${message}</div></div>
</body></html>`;
  }

  private getMapHtml(): string {
    return `<!DOCTYPE html>
<html><head><style>
  body, html { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: #0a0e14; }
  iframe { width: 100%; height: 100%; border: none; }
</style></head><body>
  <iframe id="map" src="${GUI_HOST}/hex-topology.html"></iframe>
  <script>
    const vscode = acquireVsCodeApi();

    // Forward messages from iframe (node clicks) to extension
    window.addEventListener('message', (event) => {
      if (event.data?.type === 'nodeClick') {
        vscode.postMessage({
          command: 'nodeSelected',
          file: event.data.file,
          line: event.data.line,
          nodeId: event.data.nodeId,
          name: event.data.name,
        });
      }
      // Forward extension → iframe
      if (event.data?.command === 'highlightNode' || event.data?.command === 'showTrace') {
        document.getElementById('map')?.contentWindow?.postMessage(event.data, '*');
      }
    });
  </script>
</body></html>`;
  }

  private dispose(): void {
    MapPanel.currentPanel = undefined;
    this.panel.dispose();
    this.disposables.forEach(d => d.dispose());
  }
}
