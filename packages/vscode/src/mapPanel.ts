/**
 * Map Panel — Webview panel showing the hex topology map.
 *
 * Embeds the GUI server's hex map visualization in a VS Code webview.
 * Communicates with the extension for node selection and trace visualization.
 */

import * as vscode from 'vscode';

const GUI_PORT = 3333;
const GUI_HOST = `http://localhost:${GUI_PORT}`;

export class MapPanel {
  public static currentPanel: MapPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  private constructor(panel: vscode.WebviewPanel) {
    this.panel = panel;

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    // Handle messages from webview
    this.panel.webview.onDidReceiveMessage(
      (message) => {
        switch (message.command) {
          case 'nodeSelected':
            // Open the file at the selected node's location
            if (message.file && message.line) {
              const uri = vscode.Uri.file(
                vscode.workspace.workspaceFolders?.[0]?.uri.fsPath + '/' + message.file
              );
              vscode.window.showTextDocument(uri, {
                selection: new vscode.Range(message.line - 1, 0, message.line - 1, 0),
              });
            }
            break;
        }
      },
      null,
      this.disposables
    );

    this.panel.webview.html = this.getHtml();
  }

  public static createOrShow(): void {
    const column = vscode.ViewColumn.Beside;

    if (MapPanel.currentPanel) {
      MapPanel.currentPanel.panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'grafemaMap',
      'Grafema Map',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    MapPanel.currentPanel = new MapPanel(panel);
  }

  /**
   * Highlight a node on the map by its semantic ID.
   */
  public highlightNode(nodeId: string): void {
    this.panel.webview.postMessage({ command: 'highlightNode', nodeId });
  }

  /**
   * Show a trace route on the map.
   */
  public showTrace(nodeIds: string[]): void {
    this.panel.webview.postMessage({ command: 'showTrace', nodeIds });
  }

  private getHtml(): string {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body, html { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: #0a0a0f; }
    iframe { width: 100%; height: 100%; border: none; }
    .toolbar {
      position: absolute; top: 8px; right: 8px; z-index: 10;
      display: flex; gap: 4px;
    }
    .toolbar button {
      background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2);
      color: #ccc; padding: 4px 8px; border-radius: 4px; cursor: pointer; font-size: 11px;
    }
    .toolbar button:hover { background: rgba(255,255,255,0.2); }
    .status {
      position: absolute; bottom: 8px; left: 8px; z-index: 10;
      color: #666; font-size: 11px; font-family: monospace;
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <button onclick="document.getElementById('map').src='${GUI_HOST}/hex-topology.html'">Hex Map</button>
    <button onclick="document.getElementById('map').src='${GUI_HOST}/cosmos.html'">3D Graph</button>
    <button onclick="document.getElementById('map').src='${GUI_HOST}/modules.html'">Modules</button>
  </div>
  <div class="status" id="status">Connecting to GUI server...</div>
  <iframe id="map" src="${GUI_HOST}/hex-topology.html"></iframe>

  <script>
    const vscode = acquireVsCodeApi();
    const iframe = document.getElementById('map');
    const status = document.getElementById('status');

    iframe.onload = () => { status.textContent = 'Map loaded'; };
    iframe.onerror = () => { status.textContent = 'Failed to connect to GUI server. Run: grafema-gui'; };

    // Receive messages from extension
    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.command === 'highlightNode' || msg.command === 'showTrace') {
        // Forward to iframe
        iframe.contentWindow?.postMessage(msg, '*');
      }
    });

    // Receive messages from iframe (node clicks)
    window.addEventListener('message', (event) => {
      if (event.data?.type === 'nodeClick') {
        vscode.postMessage({
          command: 'nodeSelected',
          file: event.data.file,
          line: event.data.line,
          nodeId: event.data.nodeId,
        });
      }
    });

    // Check if server is available
    fetch('${GUI_HOST}/api/stats')
      .then(r => r.json())
      .then(d => { status.textContent = d.nodeCount + ' nodes · ' + d.edgeCount + ' edges'; })
      .catch(() => { status.textContent = 'GUI server not running. Run: grafema-gui'; });
  </script>
</body>
</html>`;
  }

  private dispose(): void {
    MapPanel.currentPanel = undefined;
    this.panel.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}
