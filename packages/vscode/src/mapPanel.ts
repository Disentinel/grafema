/**
 * Map Panel — Webview panel showing the hex topology map.
 *
 * Embeds the GUI server's hex map visualization in a VS Code webview.
 * Auto-starts gui-server if not running. Shows loader during hex layout computation.
 * Communicates with the extension for node selection and trace visualization.
 */

import * as vscode from 'vscode';
import { spawn, type ChildProcess } from 'child_process';
import { existsSync, mkdirSync, renameSync, chmodSync, createWriteStream } from 'fs';
import { get as httpsGet } from 'https';
import type { IncomingMessage } from 'http';
import { homedir, platform, arch } from 'os';
import { join } from 'path';

/**
 * Find grafema-gui binary.
 *
 * Search order:
 * 1. VS Code setting: grafema.guiPath
 * 2. Bundled binary in extension (production VSIX)
 * 3. GRAFEMA_GUI environment variable
 * 4. ~/.grafema/bin/ (lazy-downloaded by CLI)
 * 5. Monorepo development paths
 */
function findGuiBinary(): string | null {
  // 1. VS Code setting
  const config = vscode.workspace.getConfiguration('grafema');
  const configPath = config.get<string>('guiPath');
  if (configPath && existsSync(configPath)) {
    return configPath;
  }

  // 2. Bundled binary (production VSIX)
  const extensionBinary = join(__dirname, '..', 'binaries', 'grafema-gui');
  if (existsSync(extensionBinary)) {
    return extensionBinary;
  }

  // 3. GRAFEMA_GUI environment variable
  const envBinary = process.env.GRAFEMA_GUI;
  if (envBinary && existsSync(envBinary)) {
    return envBinary;
  }

  // 4. ~/.grafema/bin/ (lazy-downloaded by CLI)
  const homeBinary = join(homedir(), '.grafema', 'bin', 'grafema-gui');
  if (existsSync(homeBinary)) {
    return homeBinary;
  }

  // 5. Monorepo development paths
  const possibleRoots = [
    join(__dirname, '..', '..', '..'),
    join(__dirname, '..', '..', '..', '..'),
    join(__dirname, '..', '..', '..', '..', '..'),
  ];

  for (const root of possibleRoots) {
    const releaseBinary = join(root, 'packages', 'gui-server', 'target', 'release', 'grafema-gui');
    if (existsSync(releaseBinary)) {
      return releaseBinary;
    }
    const debugBinary = join(root, 'packages', 'gui-server', 'target', 'debug', 'grafema-gui');
    if (existsSync(debugBinary)) {
      return debugBinary;
    }
  }

  return null;
}

const GITHUB_REPO = 'Disentinel/grafema';

function getPlatformDir(): string {
  const p = platform();
  const a = arch();
  if (p === 'darwin' && a === 'arm64') return 'darwin-arm64';
  if (p === 'darwin') return 'darwin-x64';
  if (p === 'linux' && a === 'arm64') return 'linux-arm64';
  return 'linux-x64';
}

function httpsGetFollowRedirects(url: string): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = httpsGet(url, { headers: { 'User-Agent': 'grafema-vscode' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const location = res.headers.location;
        if (!location) return reject(new Error('Redirect without location'));
        httpsGetFollowRedirects(location).then(resolve, reject);
        return;
      }
      resolve(res);
    });
    req.on('error', reject);
  });
}

async function downloadGuiBinary(progress: vscode.Progress<{ message: string }>): Promise<string | null> {
  const binDir = join(homedir(), '.grafema', 'bin');
  if (!existsSync(binDir)) {
    mkdirSync(binDir, { recursive: true });
  }

  const platformDir = getPlatformDir();
  const assetName = `grafema-gui-${platformDir}`;
  const targetPath = join(binDir, 'grafema-gui');
  const tmpPath = `${targetPath}.downloading`;

  // Find latest binaries-v* release
  progress.report({ message: 'Finding latest release...' });
  const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=10`;
  const apiRes = await httpsGetFollowRedirects(apiUrl);
  const chunks: Buffer[] = [];
  for await (const chunk of apiRes) {
    chunks.push(chunk as Buffer);
  }
  const releases = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as Array<{ tag_name: string }>;
  const release = releases.find(r => r.tag_name.startsWith('binaries-v'));
  if (!release) {
    throw new Error('No binaries-v* release found');
  }

  // Download binary
  const downloadUrl = `https://github.com/${GITHUB_REPO}/releases/download/${release.tag_name}/${assetName}`;
  progress.report({ message: `Downloading ${assetName}...` });
  const res = await httpsGetFollowRedirects(downloadUrl);
  if (res.statusCode !== 200) {
    throw new Error(`HTTP ${res.statusCode} — asset ${assetName} not found in ${release.tag_name}`);
  }

  await new Promise<void>((resolve, reject) => {
    const file = createWriteStream(tmpPath);
    res.pipe(file);
    file.on('finish', () => { file.close(); resolve(); });
    file.on('error', reject);
    res.on('error', reject);
  });

  renameSync(tmpPath, targetPath);
  chmodSync(targetPath, 0o755);
  return targetPath;
}

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
  public highlightNode(nodeName: string, nodeType: string, file?: string): void {
    this.panel.webview.postMessage({ command: 'highlightNode', nodeName, nodeType, file });
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

    // Find gui-server binary, download if missing
    let binary = findGuiBinary();
    if (!binary) {
      const choice = await vscode.window.showInformationMessage(
        'grafema-gui binary not found. Download from GitHub?',
        'Download', 'Cancel'
      );
      if (choice !== 'Download') return;

      try {
        binary = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Grafema' },
          (progress) => downloadGuiBinary(progress),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Failed to download grafema-gui: ${msg}`);
        return;
      }
      if (!binary) return;
    }

    const socketPath = join(root, '.grafema', 'rfdb.sock');

    // Find static files directory
    const staticDirCandidates = [
      join(__dirname, '..', 'gui-public'),                  // Bundled with extension
      join(root, 'packages', 'gui', 'public'),              // Monorepo dev
    ];
    const staticDir = staticDirCandidates.find(p => existsSync(p));

    const args = ['--socket', socketPath, '--port', String(GUI_PORT)];
    if (staticDir) {
      args.push('--static-dir', staticDir);
    }

    guiServerProcess = spawn(binary, args, {
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
