/**
 * Map Panel — Webview panel showing the hex topology map (C0 + C16).
 *
 * Iframes rfdb-server's /ui/{db} endpoint (served by the Rust rfdb-server
 * on its HTTP port).
 *
 * Responsibilities:
 *   - Resolve rfdb HTTP port + active database name via grafemaClient.
 *   - Poll the server's /api/stats until it responds.
 *   - Render a webview that embeds http://localhost:{port}/ui/{db}.
 *   - Forward node-click messages from the iframe to VS Code (open file).
 *   - Relay highlightNode / showTrace from extension into the iframe.
 *
 * CSP: the webview sets a Content-Security-Policy meta allowing
 * frame-src http://localhost:* and http://127.0.0.1:* so the iframe loads.
 */

import * as vscode from 'vscode';
import { join } from 'path';

/**
 * Port discovery — see grafemaClient.getRfdbHttpPort() for the source of truth.
 * This default is used only when the client hasn't advertised a port yet.
 * Matches the tectonic_demo memory note (3335).
 */
const DEFAULT_RFDB_HTTP_PORT = 3335;
const DEFAULT_DB_NAME = 'default';

/**
 * Test-only injection point: the test harness installs
 * globalThis.__mockRfdbHttpPort / __mockRfdbDbName before requiring this
 * module, so we fall back to them when the real grafemaClient isn't
 * available (e.g., unit tests that don't bootstrap the extension host).
 */
interface TestGlobals {
  __mockRfdbHttpPort?: () => number | undefined;
  __mockRfdbDbName?: () => string;
  /**
   * Test-only: when set, ensureServerAndLoad() skips the /api/stats
   * fetch and renders the iframe immediately. Avoids flakiness from
   * trying to mock global fetch under tsx's ESM loader.
   */
  __mapPanelSkipServerCheck?: boolean;
}

function getRfdbHttpPort(): number {
  const testGlobals = globalThis as TestGlobals;
  if (typeof testGlobals.__mockRfdbHttpPort === 'function') {
    const port = testGlobals.__mockRfdbHttpPort();
    if (typeof port === 'number') return port;
  }
  // Real lookup: ask grafemaClient module. Imported lazily to avoid a
  // circular/mock-hostile eager dependency at extension activation time.
  try {
    const mod = require('./grafemaClient') as {
      getRfdbHttpPort?: () => number | undefined;
    };
    const port = mod.getRfdbHttpPort?.();
    if (typeof port === 'number') return port;
  } catch {
    // grafemaClient may not expose the helper in some builds — fall through.
  }
  const config = vscode.workspace.getConfiguration('grafema');
  const configured = config.get<number>('rfdbHttpPort');
  if (typeof configured === 'number' && configured > 0) return configured;
  return DEFAULT_RFDB_HTTP_PORT;
}

function getDatabaseName(): string {
  const testGlobals = globalThis as TestGlobals;
  if (typeof testGlobals.__mockRfdbDbName === 'function') {
    return testGlobals.__mockRfdbDbName();
  }
  const config = vscode.workspace.getConfiguration('grafema');
  return config.get<string>('databaseName') || DEFAULT_DB_NAME;
}

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

    // DAI-16: rebuild the iframe when the user changes `grafema.databaseName`
    // or `grafema.rfdbHttpPort`. Without this the panel would keep pointing
    // at the old db even after the setting is updated, forcing a reload.
    const configSub = vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration('grafema.databaseName') ||
        e.affectsConfiguration('grafema.rfdbHttpPort')
      ) {
        this.ensureServerAndLoad();
      }
    });
    this.disposables.push(configSub);

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
  public highlightNode(nodeName: string, nodeType: string, file?: string): void {
    this.panel.webview.postMessage({ command: 'highlightNode', nodeName, nodeType, file });
  }

  /** Show a trace route on the map. */
  public showTrace(nodeNames: string[]): void {
    this.panel.webview.postMessage({ command: 'showTrace', nodeNames });
  }

  /**
   * Poll rfdb-server's /api/stats to confirm it is accepting requests, then
   * render the map iframe. The HTTP server comes up lazily on cold start
   * (~13s warmup) — we poll for up to 60s before giving up.
   *
   * Users must have rfdb-server running (started by `grafema analyze` or
   * GrafemaClientManager.startServer with --http-port). If the server is
   * not running, this panel shows a "Waiting for RFDB server" message.
   */
  private async ensureServerAndLoad(): Promise<void> {
    const port = getRfdbHttpPort();
    const db = getDatabaseName();

    // Test hook: bypass the /api/stats health check so unit tests can
    // assert on getMapHtml() output without running an HTTP server.
    const testGlobals = globalThis as TestGlobals;
    if (testGlobals.__mapPanelSkipServerCheck) {
      this.panel.webview.html = this.getMapHtml(port, db);
      return;
    }

    // Fast path: server already responding — render immediately.
    try {
      const resp = await fetch(`http://localhost:${port}/api/stats`);
      if (resp.ok) {
        this.panel.webview.html = this.getMapHtml(port, db);
        return;
      }
    } catch {
      // Server not reachable yet — fall through to polling.
    }

    this.panel.webview.html = this.getLoaderHtml('Waiting for RFDB server...');

    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        const resp = await fetch(`http://localhost:${port}/api/stats`);
        if (resp.ok) {
          // Best-effort: show layout progress while waiting for tileCount.
          const data = (await resp.json()) as { nodeCount?: number; tileCount?: number };
          if ((data.tileCount ?? 0) > 0 || (data.nodeCount ?? 0) === 0) {
            this.panel.webview.html = this.getMapHtml(port, db);
            return;
          }
          this.panel.webview.html = this.getLoaderHtml(
            `Computing hex layout... ${(data.nodeCount ?? 0).toLocaleString()} nodes`,
          );
        }
      } catch {
        // Still waiting.
      }
    }

    this.panel.webview.html = this.getLoaderHtml(
      `RFDB server did not respond on port ${port}. Run "Grafema: Analyze" first.`,
    );
  }

  private getLoaderHtml(message = 'Connecting to RFDB server...'): string {
    return `<!DOCTYPE html>
<html><head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-src http://localhost:* http://127.0.0.1:*;" />
  <style>
    body { background: #0a0e14; color: #00e5ff; font-family: 'SF Mono', monospace;
           display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
    .loader { text-align: center; }
    .spinner { width: 40px; height: 40px; border: 3px solid #00e5ff33; border-top-color: #00e5ff;
               border-radius: 50%; animation: spin 1s linear infinite; margin: 0 auto 16px; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .msg { font-size: 14px; opacity: 0.8; }
  </style>
</head><body>
  <div class="loader"><div class="spinner"></div><div class="msg">${message}</div></div>
</body></html>`;
  }

  private getMapHtml(port: number, db: string): string {
    const iframeUrl = `http://localhost:${port}/ui/${db}`;
    return `<!DOCTYPE html>
<html><head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-src http://localhost:* http://127.0.0.1:*; connect-src http://localhost:* http://127.0.0.1:*;" />
  <style>
    body, html { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: #0a0e14; }
    iframe { width: 100%; height: 100%; border: none; }
  </style>
</head><body>
  <iframe id="map" src="${iframeUrl}"></iframe>
  <script>
    const vscode = acquireVsCodeApi();

    // Forward messages from iframe (node clicks) to extension.
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
      // Forward extension -> iframe
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
    this.disposables.forEach((d) => d.dispose());
  }
}
