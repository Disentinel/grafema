/**
 * Analyze command action — spawns grafema-orchestrator for project analysis.
 *
 * The Rust grafema-orchestrator binary handles the full analysis pipeline:
 * discovery, parsing (OXC), analysis (grafema-analyzer), resolution,
 * and RFDB ingestion. This action finds the binary, spawns it with
 * the correct args, streams output, and prints a summary.
 */

import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { spawn } from 'child_process';
import {
  RFDBServerBackend,
  createLogger,
  findOrchestratorBinary,
  getBinaryNotFoundMessage,
  findAnalyzerBinary,
  ensureBinary,
  ManifestGenerator,
  ManifestResolver,
  GRAFEMA_VERSION,
  getSchemaVersion,
} from '@grafema/util';
import type { LogLevel } from '@grafema/util';
import { scanExtensions, generateSmartConfig, writeConfig, updateGitignore, formatDetected } from '../utils/quickstart.js';

export interface NodeEdgeCountBackend {
  nodeCount: () => Promise<number>;
  edgeCount: () => Promise<number>;
}

export async function fetchNodeEdgeCounts(backend: NodeEdgeCountBackend): Promise<{ nodeCount: number; edgeCount: number }> {
  const [nodeCount, edgeCount] = await Promise.all([backend.nodeCount(), backend.edgeCount()]);
  return { nodeCount, edgeCount };
}

export function exitWithCode(code: number, exitFn: (code: number) => void = process.exit): void {
  exitFn(code);
}

/**
 * Determine log level from CLI options.
 * Priority: --log-level > --quiet > --verbose > default ('silent')
 *
 * By default, logs are silent to allow clean progress UI.
 * Use --verbose to see detailed logs (disables interactive progress).
 */
function getLogLevel(options: { quiet?: boolean; verbose?: boolean; logLevel?: string }): LogLevel {
  if (options.logLevel) {
    const validLevels: LogLevel[] = ['silent', 'errors', 'warnings', 'info', 'debug'];
    if (validLevels.includes(options.logLevel as LogLevel)) {
      return options.logLevel as LogLevel;
    }
  }
  if (options.quiet) return 'silent';
  if (options.verbose) return 'info';  // --verbose shows logs instead of progress UI
  return 'silent';  // Default: silent logs, clean progress UI
}

/**
 * Find the grafema.config.yaml config file for the orchestrator.
 *
 * Search order:
 * 1. <projectPath>/grafema.config.yaml
 * 2. <projectPath>/.grafema/config.yaml (legacy location)
 */
function findConfigFile(projectPath: string): string | null {
  const candidates = [
    join(projectPath, 'grafema.config.yaml'),
    join(projectPath, '.grafema', 'config.yaml'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

/** Map of file extensions to required analyzer binaries. */
const EXT_TO_BINARIES: Record<string, string[]> = {
  // JS/TS — always needed (core)
  js: ['grafema-analyzer', 'grafema-resolve'],
  ts: ['grafema-analyzer', 'grafema-resolve'],
  jsx: ['grafema-analyzer', 'grafema-resolve'],
  tsx: ['grafema-analyzer', 'grafema-resolve'],
  mjs: ['grafema-analyzer', 'grafema-resolve'],
  cjs: ['grafema-analyzer', 'grafema-resolve'],
  // Python
  py: ['grafema-python-analyzer', 'python-resolve'],
  pyi: ['grafema-python-analyzer', 'python-resolve'],
  // Haskell
  hs: ['haskell-analyzer', 'haskell-resolve'],
  // Rust
  rs: ['grafema-rust-analyzer', 'grafema-rust-resolve'],
  // Java
  java: ['grafema-java-analyzer', 'java-resolve', 'java-parser'],
  // Kotlin
  kt: ['grafema-kotlin-analyzer', 'kotlin-resolve', 'kotlin-parser'],
  kts: ['grafema-kotlin-analyzer', 'kotlin-resolve', 'kotlin-parser'],
  // Go
  go: ['grafema-go-analyzer', 'go-resolve', 'go-parser'],
  // C/C++
  c: ['grafema-cpp-analyzer', 'cpp-resolve'],
  cpp: ['grafema-cpp-analyzer', 'cpp-resolve'],
  h: ['grafema-cpp-analyzer', 'cpp-resolve'],
  hpp: ['grafema-cpp-analyzer', 'cpp-resolve'],
  // Swift
  swift: ['grafema-swift-analyzer', 'swift-resolve', 'swift-parser'],
  // Obj-C
  m: ['grafema-objc-analyzer', 'objc-parser'],
  mm: ['grafema-objc-analyzer', 'objc-parser'],
  // BEAM (Elixir/Erlang)
  ex: ['beam-analyzer', 'beam-resolve'],
  exs: ['beam-analyzer', 'beam-resolve'],
  erl: ['beam-analyzer', 'beam-resolve'],
};

/**
 * Detect languages from config include patterns and ensure their analyzer binaries exist.
 * Reads the config file as text, extracts file extensions from include globs,
 * and pre-downloads missing binaries before the orchestrator needs them.
 */
async function ensureLanguageBinaries(configPath: string, log: (...args: unknown[]) => void): Promise<void> {
  const configText = readFileSync(configPath, 'utf-8');

  // Extract extensions from include patterns like "**/*.py", '**/*.ts', etc.
  const neededBinaries = new Set<string>();
  for (const match of configText.matchAll(/\*\.(\w+)/g)) {
    const ext = match[1];
    const bins = EXT_TO_BINARIES[ext];
    if (bins) bins.forEach(b => neededBinaries.add(b));
  }

  // Always ensure JS/TS binaries (most common, default language)
  for (const b of ['grafema-analyzer', 'grafema-resolve']) {
    neededBinaries.add(b);
  }

  for (const binName of neededBinaries) {
    // findAnalyzerBinary checks platform npm package + PATH (always current)
    if (findAnalyzerBinary(binName)) continue;
    // ensureBinary handles ~/.grafema/bin/ with version check + lazy download
    const downloaded = await ensureBinary(binName, null, log);
    if (downloaded) {
      log(`Downloaded ${binName} → ${downloaded}`);
    }
  }
}

export async function analyzeAction(path: string, options: { service?: string; entrypoint?: string; clear?: boolean; quiet?: boolean; verbose?: boolean; debug?: boolean; logLevel?: string; logFile?: string; strict?: boolean; resolveJobs?: string; autoStart?: boolean; quickstart?: boolean }): Promise<void> {
  const projectPath = resolve(path);
  const grafemaDir = join(projectPath, '.grafema');
  const dbPath = join(grafemaDir, 'graph.rfdb');

  if (!existsSync(grafemaDir)) {
    mkdirSync(grafemaDir, { recursive: true });
  }

  // Two log levels for CLI output:
  // - info: important results (shows unless --quiet)
  // - debug: verbose details (shows only with --verbose)
  const info = options.quiet ? () => {} : console.log;
  const debug = options.verbose ? console.log : () => {};

  // Create logger based on CLI flags
  const logLevel = getLogLevel(options);
  const logFile = options.logFile ? resolve(options.logFile) : undefined;
  const _logger = createLogger(logLevel, logFile ? { logFile } : undefined);

  if (logFile) {
    debug(`Log file: ${logFile}`);
  }
  debug(`Analyzing project: ${projectPath}`);

  // Find grafema-orchestrator binary (lazy download if missing)
  let orchestratorBinary = findOrchestratorBinary();
  if (!orchestratorBinary) {
    const downloaded = await ensureBinary('grafema-orchestrator', null, info);
    if (downloaded) {
      debug(`Downloaded grafema-orchestrator → ${downloaded}`);
      orchestratorBinary = downloaded;
    }
  }
  if (!orchestratorBinary) {
    console.error('');
    console.error(getBinaryNotFoundMessage('grafema-orchestrator'));
    process.exit(1);
  }

  debug(`Using orchestrator: ${orchestratorBinary}`);

  // Find config file for the orchestrator
  let configPath = findConfigFile(projectPath);
  if (!configPath && options.quickstart) {
    // Quickstart: auto-generate config by scanning the project
    const detected = scanExtensions(projectPath);
    const configContent = generateSmartConfig(detected);
    writeConfig(projectPath, configContent);
    updateGitignore(projectPath);

    if (detected.size > 0) {
      info(`Quickstart: detected ${formatDetected(detected)}`);
    } else {
      info('Quickstart: no supported files detected, using all extensions');
    }
    info('Created .grafema/config.yaml');
    info('');

    configPath = findConfigFile(projectPath);
  }
  if (!configPath) {
    console.error('');
    console.error('No grafema config file found.');
    console.error('');
    console.error('Expected one of:');
    console.error(`  ${join(projectPath, 'grafema.config.yaml')}`);
    console.error(`  ${join(projectPath, '.grafema', 'config.yaml')}`);
    console.error('');
    console.error('Run with --quickstart to auto-generate, or create manually:');
    console.error('  root: "."');
    console.error('  include:');
    console.error('    - "**/*.js"');
    console.error('');
    process.exit(1);
  }

  debug(`Using config: ${configPath}`);

  // Ensure analyzer binaries exist for detected languages (lazy download if missing)
  await ensureLanguageBinaries(configPath, debug);

  // Connect to RFDB server — auto-start by default (zero-config UX)
  const backend = new RFDBServerBackend({
    dbPath,
    autoStart: options.autoStart ?? true,
    silent: !options.verbose,
    clientName: 'cli'
  });

  try {
    await backend.connect();
  } catch (err) {
    if (err instanceof Error && err.message.includes('not running')) {
      console.error('');
      console.error('RFDB server failed to start.');
      console.error('');
      console.error('Try starting manually:');
      console.error('  grafema server start');
      console.error('');
      console.error('Or run diagnostics:');
      console.error('  grafema doctor');
      console.error('');
      process.exit(1);
    }
    throw err;
  }

  if (options.clear) {
    debug('Clearing existing database...');
    await backend.clear();
    // Shutdown + restart server for clean state.
    // Without this, the old server keeps running with a stale socket
    // after the orchestrator finishes, causing "connection failed" in extension.
    debug('Restarting server for clean state...');
    await backend.shutdownServer();
    await backend.connect(); // auto-starts a fresh server
  }

  const startTime = Date.now();

  // Build orchestrator args
  const args: string[] = ['analyze', '--config', configPath, '--socket', backend.socketPath];

  if (options.clear) {
    args.push('--force');
  }

  if (options.resolveJobs) {
    args.push('--resolve-jobs', options.resolveJobs);
  }

  debug(`Spawning: ${orchestratorBinary} ${args.join(' ')}`);

  let exitCode = 0;

  try {
    // Spawn grafema-orchestrator
    exitCode = await new Promise<number>((resolvePromise, reject) => {
      const child = spawn(orchestratorBinary, args, {
        stdio: [
          'ignore',
          options.quiet ? 'ignore' : 'inherit',
          options.quiet ? 'ignore' : 'inherit',
        ],
        env: {
          ...process.env,
          // Pass RUST_LOG for tracing verbosity
          RUST_LOG: options.debug ? 'debug' : (options.quiet ? 'warn' : 'info'),
        },
      });

      child.on('error', (err) => {
        reject(new Error(`Failed to spawn grafema-orchestrator: ${err.message}`));
      });

      child.on('close', (code) => {
        resolvePromise(code ?? 1);
      });
    });

    if (exitCode === 0) {
      const elapsedSeconds = (Date.now() - startTime) / 1000;
      const stats = await fetchNodeEdgeCounts(backend);

      info('');
      info(`Analysis complete in ${elapsedSeconds.toFixed(2)}s`);
      info(`  Nodes: ${stats.nodeCount}`);
      info(`  Edges: ${stats.edgeCount}`);

      // Generate manifest after successful analysis
      try {
        const manifestPath = await generateManifest(backend, projectPath, grafemaDir, debug);
        if (manifestPath) {
          info(`  Manifest: ${manifestPath}`);
        }
      } catch (err) {
        debug(`Manifest generation skipped: ${err instanceof Error ? err.message : String(err)}`);
      }

      // Auto-update config version if it differs (prevents patch mismatch warnings)
      try {
        const currentSchema = getSchemaVersion(GRAFEMA_VERSION);
        const configContent = readFileSync(configPath, 'utf-8');
        const versionMatch = configContent.match(/^version:\s*["']?([^"'\s]+)["']?/m);
        if (versionMatch && versionMatch[1] !== currentSchema) {
          const updated = configContent.replace(
            /^version:\s*["']?[^"'\s]+["']?/m,
            `version: ${currentSchema}`
          );
          writeFileSync(configPath, updated);
          debug(`Config version updated: ${versionMatch[1]} → ${currentSchema}`);
        }
      } catch {
        debug('Config version auto-update skipped');
      }

      // Auto-load registry manifests for cross-package resolution
      const registryDir = join(projectPath, 'registry');
      if (existsSync(registryDir)) {
        try {
          const resolver = new ManifestResolver();
          const loaded = resolver.loadFromRegistry(registryDir);
          if (loaded > 0) {
            info(`  Registry: ${loaded} package manifests loaded`);
          }
        } catch (err) {
          debug(`Registry loading skipped: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } else {
      console.error('');
      console.error(`Analysis failed with exit code ${exitCode}`);
    }
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    console.error('');
    console.error(`Analysis failed: ${error.message}`);
    exitCode = 1;
  } finally {
    if (backend.connected) {
      await backend.close();
    }

    // Exit with appropriate code
    exitWithCode(exitCode);
  }
}

/**
 * Generate manifest.yaml after successful analysis.
 * Reads package.json to determine package name and entry point,
 * then runs ManifestGenerator against the graph.
 */
async function generateManifest(
  backend: RFDBServerBackend,
  projectPath: string,
  grafemaDir: string,
  debug: (...args: unknown[]) => void,
): Promise<string | null> {
  const pkgJsonPath = join(projectPath, 'package.json');
  if (!existsSync(pkgJsonPath)) {
    debug('No package.json found, skipping manifest generation');
    return null;
  }

  const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8')) as {
    name?: string;
    version?: string;
    main?: string;
    exports?: Record<string, unknown>;
  };

  if (!pkgJson.name) {
    debug('No package name in package.json, skipping manifest generation');
    return null;
  }

  // Determine entry file: prefer exports["."] or main field
  let entryFile: string | undefined;
  if (pkgJson.exports) {
    const dotExport = pkgJson.exports['.'];
    if (typeof dotExport === 'string') {
      entryFile = dotExport;
    } else if (dotExport && typeof dotExport === 'object') {
      const importField = (dotExport as Record<string, string>).import ?? (dotExport as Record<string, string>).default;
      if (importField) entryFile = importField;
    }
  }
  if (!entryFile && pkgJson.main) {
    entryFile = pkgJson.main;
  }

  // Convert dist entry to src (e.g., "dist/index.js" → "src/index.ts")
  if (entryFile) {
    entryFile = entryFile
      .replace(/^\.\//, '')
      .replace(/^dist\//, 'src/')
      .replace(/\.js$/, '.ts');
  }

  const purl = `pkg:npm/${pkgJson.name}${pkgJson.version ? `@${pkgJson.version}` : ''}`;

  // Look for effects-db relative to CLI package
  const cliDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const effectsDbCandidates = [
    join(cliDir, 'effects-db'),
    join(projectPath, 'effects-db'),
  ];
  const effectsDbPath = effectsDbCandidates.find(p => existsSync(p));

  debug(`Generating manifest for ${pkgJson.name}`);
  debug(`  purl: ${purl}`);
  debug(`  entryFile: ${entryFile ?? '(none)'}`);
  debug(`  effectsDb: ${effectsDbPath ?? '(none)'}`);

  const gen = new ManifestGenerator(backend, {
    purl,
    effectsDbPath,
    grafemaDir,
    sourceType: 'source',
    entryFile,
  });

  const manifest = await gen.generate();
  const yaml = ManifestGenerator.toYaml(manifest);

  const manifestPath = join(projectPath, 'manifest.yaml');
  writeFileSync(manifestPath, yaml, 'utf-8');

  debug(`  exports: ${manifest.exports.length}, imports: ${manifest.imports.length}`);

  return manifestPath;
}
