/**
 * Orchestrator binary discovery and analysis runner.
 *
 * Finds grafema-orchestrator binary and spawns it to analyze the project,
 * streaming output to a VS Code OutputChannel with progress reporting.
 */

import type { ChildProcess } from 'child_process';
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import * as vscode from 'vscode';

/**
 * Find grafema-orchestrator binary.
 *
 * Search order:
 * 1. VS Code setting: grafema.orchestratorPath
 * 2. Bundled binary in extension (production VSIX)
 * 3. GRAFEMA_ORCHESTRATOR environment variable
 * 4. Monorepo development paths
 */
export function findOrchestratorBinary(): string | null {
  // 1. VS Code setting
  const config = vscode.workspace.getConfiguration('grafema');
  const configPath = config.get<string>('orchestratorPath');
  if (configPath && existsSync(configPath)) {
    return configPath;
  }

  // 2. Bundled binary (production)
  // After esbuild, __dirname is packages/vscode/dist
  // Binary is at packages/vscode/binaries/grafema-orchestrator
  const extensionBinary = join(__dirname, '..', 'binaries', 'grafema-orchestrator');
  if (existsSync(extensionBinary)) {
    return extensionBinary;
  }

  // 3. GRAFEMA_ORCHESTRATOR environment variable
  const envBinary = process.env.GRAFEMA_ORCHESTRATOR;
  if (envBinary && existsSync(envBinary)) {
    return envBinary;
  }

  // 4. Monorepo development paths
  const possibleRoots = [
    join(__dirname, '..', '..', '..'),
    join(__dirname, '..', '..', '..', '..'),
    join(__dirname, '..', '..', '..', '..', '..'),
  ];

  for (const root of possibleRoots) {
    const releaseBinary = join(root, 'packages', 'grafema-orchestrator', 'target', 'release', 'grafema-orchestrator');
    if (existsSync(releaseBinary)) {
      return releaseBinary;
    }
    const debugBinary = join(root, 'packages', 'grafema-orchestrator', 'target', 'debug', 'grafema-orchestrator');
    if (existsSync(debugBinary)) {
      return debugBinary;
    }
  }

  return null;
}

/**
 * Find Grafema config file in the workspace.
 * Returns the path to the config file, or null if not found.
 */
export function findConfigFile(workspaceRoot: string): string | null {
  const candidates = [
    join(workspaceRoot, 'grafema.config.yaml'),
    join(workspaceRoot, '.grafema', 'config.yaml'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export interface AnalyzeOptions {
  workspaceRoot: string;
  socketPath: string;
  force?: boolean;
  token: vscode.CancellationToken;
  outputChannel: vscode.OutputChannel;
  onProgress?: (message: string) => void;
}

export interface AnalyzeResult {
  exitCode: number;
  elapsed: number;
}

/**
 * Run grafema-orchestrator analyze command.
 *
 * Spawns the orchestrator binary, streams output to the output channel,
 * and reports progress. Supports cancellation via CancellationToken.
 */
export async function runAnalyze(options: AnalyzeOptions): Promise<AnalyzeResult> {
  const { workspaceRoot, socketPath, force, token, outputChannel, onProgress } = options;

  const orchestratorPath = findOrchestratorBinary();
  if (!orchestratorPath) {
    throw new Error(
      'grafema-orchestrator binary not found.\n' +
      'Set grafema.orchestratorPath in VS Code settings,\n' +
      'or set GRAFEMA_ORCHESTRATOR environment variable.'
    );
  }

  const configPath = findConfigFile(workspaceRoot);
  if (!configPath) {
    throw new Error(
      'No Grafema config found.\n' +
      'Run "Grafema: Initialize Project" first to create .grafema/config.yaml.'
    );
  }

  const args = ['analyze', '--config', configPath, '--socket', socketPath];
  if (force) {
    args.push('--force');
  }

  outputChannel.appendLine(`[grafema] Orchestrator: ${orchestratorPath}`);
  outputChannel.appendLine(`[grafema] Config: ${configPath}`);
  outputChannel.appendLine(`[grafema] Socket: ${socketPath}`);
  outputChannel.appendLine(`[grafema] Args: ${args.join(' ')}`);
  outputChannel.appendLine('');

  const startTime = Date.now();

  return new Promise<AnalyzeResult>((resolve, reject) => {
    let child: ChildProcess;

    try {
      child = spawn(orchestratorPath, args, {
        cwd: workspaceRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          RUST_LOG: 'info',
        },
      });
    } catch (err) {
      reject(new Error(`Failed to spawn orchestrator: ${err instanceof Error ? err.message : String(err)}`));
      return;
    }

    // Handle cancellation
    const cancelListener = token.onCancellationRequested(() => {
      outputChannel.appendLine('\n[grafema] Analysis cancelled by user');
      child.kill('SIGTERM');
    });

    // Parse orchestrator tracing output for progress reporting.
    // Orchestrator uses `tracing` crate — structured logs go to stderr.
    // Final summary ("Analyzed N files...") goes to stdout.
    //
    // Key patterns:
    //   [N/M] Analyzing path/to/file     — per-file progress (every 100th file if >100)
    //   Discovered files                  — discovery phase
    //   Partitioned files by language     — partitioning phase
    //   Analyzing JS/TS files             — language phase start
    //   Committing batch to RFDB          — ingestion phase
    //   Analyzed N files (...)            — final summary (stdout)
    const parseProgress = (text: string) => {
      if (!onProgress) return;
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Per-file progress: [42/150] Analyzing src/foo.ts
        const fileMatch = trimmed.match(/\[(\d+)\/(\d+)\]\s+Analyzing\s+(.+)/);
        if (fileMatch) {
          const [, current, total, file] = fileMatch;
          const shortFile = file.length > 40 ? '...' + file.slice(-37) : file;
          onProgress(`[${current}/${total}] ${shortFile}`);
          continue;
        }

        // Phase-level messages
        if (trimmed.includes('Discovered files')) {
          const countMatch = trimmed.match(/count=(\d+)/);
          onProgress(`Discovering files${countMatch ? ` (${countMatch[1]} found)` : ''}...`);
        } else if (trimmed.includes('Partitioned files')) {
          onProgress('Partitioning by language...');
        } else if (trimmed.includes('Filtered files for analysis')) {
          const changedMatch = trimmed.match(/changed=(\d+)/);
          const skippedMatch = trimmed.match(/skipped=(\d+)/);
          const parts = [];
          if (changedMatch) parts.push(`${changedMatch[1]} changed`);
          if (skippedMatch) parts.push(`${skippedMatch[1]} cached`);
          onProgress(parts.length ? `Filtered: ${parts.join(', ')}` : 'Filtering files...');
        } else if (trimmed.match(/Analyzing\s+(JS\/TS|Haskell|Rust|Java|Kotlin|Python|Go|C\/C\+\+|BEAM)\s+files/)) {
          const langMatch = trimmed.match(/Analyzing\s+(\S+)\s+files/);
          const countMatch = trimmed.match(/count=(\d+)/);
          if (langMatch) {
            onProgress(`Analyzing ${langMatch[1]}${countMatch ? ` (${countMatch[1]} files)` : ''}...`);
          }
        } else if (trimmed.includes('Committing batch')) {
          const progressMatch = trimmed.match(/progress="?(\d+\/\d+)"?/);
          onProgress(`Committing${progressMatch ? ` batch ${progressMatch[1]}` : ''}...`);
        } else if (trimmed.startsWith('Analyzed ')) {
          // Final summary from stdout
          onProgress(trimmed.slice(0, 80));
        }
      }
    };

    // Stream stdout (final summary)
    child.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
      outputChannel.append(text);
      parseProgress(text);
    });

    // Stream stderr (tracing logs — main progress source)
    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      outputChannel.append(text);
      parseProgress(text);
    });

    child.on('error', (err) => {
      cancelListener.dispose();
      reject(new Error(`Orchestrator process error: ${err.message}`));
    });

    child.on('close', (code) => {
      cancelListener.dispose();
      const elapsed = (Date.now() - startTime) / 1000;
      resolve({ exitCode: code ?? 1, elapsed });
    });
  });
}
