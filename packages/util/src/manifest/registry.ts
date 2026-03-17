/**
 * RegistryBuilder — builds a local manifest registry from npm packages.
 *
 * Resolves installed npm packages, analyzes each via grafema-orchestrator,
 * generates manifest.yaml with ManifestGenerator, and writes to a registry/
 * directory with an index.yaml catalog.
 *
 * Usage:
 *   const builder = new RegistryBuilder({ projectPath: '.', registryDir: './registry' });
 *   await builder.buildPackage('commander');
 *   await builder.buildAll();
 *   await builder.writeIndex();
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync, cpSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { createRequire } from 'module';
import { spawn } from 'child_process';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { tmpdir } from 'os';

import { GRAFEMA_VERSION } from '../version.js';
import { findOrchestratorBinary } from '../utils/findRfdbBinary.js';
import { ensureBinary } from '../utils/lazyDownload.js';
import { RFDBServerBackend } from '../storage/backends/RFDBServerBackend.js';
import { ManifestGenerator } from './generator.js';
import type { Manifest, ManifestPackage } from './types.js';

// ── Types ──────────────────────────────────────────────────

export interface RegistryEntry {
  name: string;
  version: string;
  purl: string;
  source_type: ManifestPackage['source_type'];
  confidence: number;
  total_exports: number;
}

export interface RegistryIndex {
  schema_version: number;
  generated: string;
  analyzer_version: string;
  entries: RegistryEntry[];
}

export interface RegistryBuilderOptions {
  /** Absolute path to the project root */
  projectPath: string;
  /** Absolute path to the registry output directory */
  registryDir: string;
  /** Path to effects-db directory (auto-detected if omitted) */
  effectsDbPath?: string;
  /** Skip packages exceeding this file count */
  maxFiles?: number;
  /** Per-package timeout in ms (default: 120000) */
  timeout?: number;
  /** Force rebuild even if manifest exists */
  force?: boolean;
  /** Verbose logging */
  verbose?: boolean;
  /** Packages to skip */
  skip?: string[];
}

export interface BuildResult {
  name: string;
  version: string;
  success: boolean;
  manifestPath?: string;
  error?: string;
  durationMs: number;
}

type LogFn = (...args: unknown[]) => void;

// ── Package Resolution ─────────────────────────────────────

/**
 * Resolve a package's directory from the project root.
 *
 * Strategy:
 * 1. Try createRequire from project root (works for direct deps)
 * 2. Try createRequire from each workspace package (pnpm strict mode)
 * 3. Walk pnpm store directly (fallback for deeply nested deps)
 */
export function resolvePackageDir(packageName: string, projectPath: string): string | null {
  // Collect resolution roots: project root + workspace packages
  const roots = [projectPath];

  // Discover workspace packages for pnpm monorepo resolution
  const pnpmWorkspace = join(projectPath, 'pnpm-workspace.yaml');
  if (existsSync(pnpmWorkspace)) {
    // Quick scan: find package.json files in packages/*/
    const packagesDir = join(projectPath, 'packages');
    if (existsSync(packagesDir)) {
      try {
        const entries = readdirSync(packagesDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const pkgPath = join(packagesDir, entry.name);
            if (existsSync(join(pkgPath, 'package.json'))) {
              roots.push(pkgPath);
            }
          }
        }
      } catch {
        // Ignore readdir errors
      }
    }
  }

  // Try createRequire from each root
  for (const root of roots) {
    const resolved = resolvePackageFromRoot(packageName, root);
    if (resolved) return resolved;
  }

  // Fallback: walk pnpm store directly
  return resolveFromPnpmStore(packageName, projectPath);
}

function resolvePackageFromRoot(packageName: string, root: string): string | null {
  const req = createRequire(join(root, 'package.json'));

  // Strategy 1: resolve <pkg>/package.json directly
  try {
    const pkgJsonPath = req.resolve(`${packageName}/package.json`);
    const dir = dirname(pkgJsonPath);
    // Verify this is the actual package root (not dist/cjs/package.json etc.)
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
    if (pkg.name === packageName) return dir;
    // Wrong package.json (e.g., dist/cjs/package.json with just {"type":"commonjs"})
    // — walk up from this location to find the real root
    return walkUpToPackageRoot(packageName, dir);
  } catch {
    // package.json subpath not exported or not resolvable
  }

  // Strategy 2: resolve main entry, walk up to find package root
  try {
    const mainPath = req.resolve(packageName);
    return walkUpToPackageRoot(packageName, dirname(mainPath));
  } catch {
    // Not resolvable from this root
  }

  return null;
}

function walkUpToPackageRoot(packageName: string, startDir: string): string | null {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, 'package.json'))) {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'));
      if (pkg.name === packageName) return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function resolveFromPnpmStore(packageName: string, projectPath: string): string | null {
  const nodeModules = join(projectPath, 'node_modules');
  const pnpmDir = join(nodeModules, '.pnpm');
  if (!existsSync(pnpmDir)) return null;

  try {
    // pnpm store structure: .pnpm/<name>@<version>/node_modules/<name>/
    // For scoped: .pnpm/@scope+name@<version>/node_modules/@scope/name/
    const escapedName = packageName.replace('/', '+');
    const entries = readdirSync(pnpmDir);
    for (const entry of entries) {
      if (entry.startsWith(`${escapedName}@`)) {
        const candidate = join(pnpmDir, entry, 'node_modules', packageName);
        if (existsSync(join(candidate, 'package.json'))) {
          return candidate;
        }
      }
    }
  } catch {
    // Ignore store access errors
  }

  return null;
}

/**
 * Detect source type of an npm package.
 *
 * - `dts_only`: Only .d.ts files (e.g., @types/node)
 * - `compiled_js`: Standard npm package with JS output
 * - `minified`: Bundled output with runtime helpers (esbuild, webpack, rollup)
 * - `source`: Has src/ with .ts files (rare for npm packages)
 */
export function detectSourceType(packageDir: string): ManifestPackage['source_type'] {
  const pkgJsonPath = join(packageDir, 'package.json');
  if (!existsSync(pkgJsonPath)) return 'compiled_js';

  const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));

  // @types/* packages are .d.ts only
  if (pkgJson.name?.startsWith('@types/')) return 'dts_only';

  // Check for types-only (e.g., has "types" but no "main"/"exports")
  if (pkgJson.types && !pkgJson.main && !pkgJson.exports) return 'dts_only';

  // Check for source TypeScript
  if (existsSync(join(packageDir, 'src', 'index.ts'))) return 'source';

  // Detect bundler output (esbuild, webpack, rollup) by checking entry file
  const entryPoint = resolveEntryPoint(pkgJson);
  if (entryPoint) {
    const entryPath = join(packageDir, entryPoint.replace(/^\.\//, ''));
    if (existsSync(entryPath)) {
      try {
        // Read first 500 bytes — bundler signatures are in the header
        const fd = readFileSync(entryPath, { encoding: 'utf-8', flag: 'r' });
        const header = fd.slice(0, 500);
        // esbuild: var __defProp = Object.defineProperty; var __export = ...
        // webpack: /******/ (() => { // webpackBootstrap
        // rollup: usually clean, not detectable this way
        if (header.includes('var __defProp = Object.defineProperty') ||
            header.includes('__webpack_require__') ||
            header.includes('webpackBootstrap')) {
          return 'minified';
        }
      } catch {
        // Ignore read errors
      }
    }
  }

  return 'compiled_js';
}

/**
 * Resolve entry point from package.json fields.
 * Follows Node.js resolution order: exports["."] → main → index.js
 */
export function resolveEntryPoint(pkgJson: Record<string, unknown>): string | null {
  // 1. exports["."]
  const exports = pkgJson.exports as Record<string, unknown> | undefined;
  if (exports) {
    const dot = exports['.'];
    if (typeof dot === 'string') return dot;
    if (dot && typeof dot === 'object') {
      const dotObj = dot as Record<string, unknown>;
      // Prefer: import → require → default
      const entry = dotObj.import ?? dotObj.require ?? dotObj.default;
      if (typeof entry === 'string') return entry;
      // Nested conditions (e.g., { import: { types: ..., default: ... } })
      if (entry && typeof entry === 'object') {
        const nested = entry as Record<string, string>;
        if (nested.default) return nested.default;
      }
    }
  }

  // 2. main field
  if (typeof pkgJson.main === 'string') return pkgJson.main;

  // 3. module field (ESM)
  if (typeof pkgJson.module === 'string') return pkgJson.module;

  return null;
}

// ── RegistryBuilder ────────────────────────────────────────

export class RegistryBuilder {
  private options: Required<Omit<RegistryBuilderOptions, 'effectsDbPath' | 'skip'>> & {
    effectsDbPath?: string;
    skip: string[];
  };
  private results: BuildResult[] = [];
  private info: LogFn;
  private debug: LogFn;

  constructor(options: RegistryBuilderOptions) {
    this.options = {
      projectPath: resolve(options.projectPath),
      registryDir: resolve(options.registryDir),
      effectsDbPath: options.effectsDbPath,
      maxFiles: options.maxFiles ?? 5000,
      timeout: options.timeout ?? 600_000,
      force: options.force ?? false,
      verbose: options.verbose ?? false,
      skip: options.skip ?? [],
    };

    this.info = console.log;
    this.debug = this.options.verbose ? console.log : () => {};
  }

  /**
   * Discover all external (non-workspace) dependencies from package.json
   * files in the project, including workspace packages.
   */
  discoverDependencies(): string[] {
    const deps = new Set<string>();

    const collectDeps = (pkgPath: string) => {
      if (!existsSync(pkgPath)) return;
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      for (const key of ['dependencies', 'devDependencies']) {
        const section = pkg[key] as Record<string, string> | undefined;
        if (!section) continue;
        for (const [name, version] of Object.entries(section)) {
          if (version.startsWith('workspace:')) continue;
          deps.add(name);
        }
      }
    };

    // Root package.json
    collectDeps(join(this.options.projectPath, 'package.json'));

    // Workspace packages (pnpm monorepo)
    const packagesDir = join(this.options.projectPath, 'packages');
    if (existsSync(packagesDir)) {
      try {
        const entries = readdirSync(packagesDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            collectDeps(join(packagesDir, entry.name, 'package.json'));
          }
        }
      } catch {
        // Ignore readdir errors
      }
    }

    return [...deps].sort();
  }

  /**
   * Build manifest for a single package.
   */
  async buildPackage(packageName: string): Promise<BuildResult> {
    const startTime = Date.now();

    if (this.options.skip.includes(packageName)) {
      return this.recordResult(packageName, '', false, 'Skipped (in skip list)', startTime);
    }

    // 1. Resolve package directory
    const packageDir = resolvePackageDir(packageName, this.options.projectPath);
    if (!packageDir) {
      return this.recordResult(packageName, '', false, 'Package not found in node_modules', startTime);
    }

    // 2. Read package.json
    const pkgJsonPath = join(packageDir, 'package.json');
    if (!existsSync(pkgJsonPath)) {
      return this.recordResult(packageName, '', false, 'No package.json', startTime);
    }

    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
    const version = pkgJson.version ?? '0.0.0';

    // 3. Check if already built (unless --force)
    const manifestDir = this.getManifestDir(packageName, version);
    const manifestPath = join(manifestDir, 'manifest.yaml');
    if (!this.options.force && existsSync(manifestPath)) {
      this.debug(`  [skip] ${packageName}@${version} — already built`);
      return this.recordResult(packageName, version, true, undefined, startTime, manifestPath);
    }

    // 4. Detect source type
    const sourceType = detectSourceType(packageDir);
    if (sourceType === 'dts_only') {
      this.debug(`  [skip] ${packageName}@${version} — dts_only (no runtime code)`);
      return this.recordResult(packageName, version, false, 'dts_only packages not analyzable', startTime);
    }
    if (sourceType === 'minified') {
      // Emit a stub manifest — package exists but exports aren't statically resolvable
      this.debug(`  [stub] ${packageName}@${version} — bundled output, emitting stub manifest`);
      const manifestDir = this.getManifestDir(packageName, version);
      const manifestPath = join(manifestDir, 'manifest.yaml');
      mkdirSync(manifestDir, { recursive: true });
      const stub: Manifest = {
        schema_version: 1,
        analyzer_version: GRAFEMA_VERSION,
        authored: false,
        confidence: 0,
        generated: new Date().toISOString(),
        package: { purl: `pkg:npm/${packageName}@${version}`, source_type: 'minified' },
        exports: [],
        imports: [],
        capabilities: { total_exports: 0, total_internal_symbols: 0, has_graph: false },
      };
      writeFileSync(manifestPath, stringifyYaml(stub), 'utf-8');
      this.info(`  [stub] ${packageName}@${version} — bundled/minified, exports not statically resolvable`);
      return this.recordResult(packageName, version, true, undefined, startTime, manifestPath);
    }

    // 5. Resolve entry point
    const entryPoint = resolveEntryPoint(pkgJson);
    this.debug(`  Entry: ${entryPoint ?? '(auto-detect)'}`);
    this.debug(`  Source: ${sourceType}`);
    this.debug(`  Dir: ${packageDir}`);

    // 6. Analyze via orchestrator + generate manifest
    try {
      const manifest = await this.analyzeAndGenerate(packageName, version, packageDir, sourceType, entryPoint);

      // 7. Write manifest to registry
      mkdirSync(manifestDir, { recursive: true });
      const yaml = ManifestGenerator.toYaml(manifest);
      writeFileSync(manifestPath, yaml, 'utf-8');

      this.info(`  [ok] ${packageName}@${version} — ${manifest.exports.length} exports, confidence ${manifest.confidence.toFixed(2)}`);
      return this.recordResult(packageName, version, true, undefined, startTime, manifestPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.info(`  [fail] ${packageName}@${version} — ${message}`);
      return this.recordResult(packageName, version, false, message, startTime);
    }
  }

  /**
   * Build manifests for all discovered dependencies.
   */
  async buildAll(): Promise<BuildResult[]> {
    const deps = this.discoverDependencies();
    this.info(`\nDiscovered ${deps.length} external dependencies\n`);

    for (const dep of deps) {
      this.info(`Building ${dep}...`);
      await this.buildPackage(dep);
    }

    return this.results;
  }

  /**
   * Build manifests for specific packages.
   */
  async buildPackages(names: string[]): Promise<BuildResult[]> {
    for (const name of names) {
      this.info(`Building ${name}...`);
      await this.buildPackage(name);
    }
    return this.results;
  }

  /**
   * Write index.yaml catalog from all manifests in the registry.
   * Merges with existing index to preserve entries from previous runs.
   */
  writeIndex(): string {
    const registryDir = this.options.registryDir;
    if (!existsSync(registryDir)) {
      mkdirSync(registryDir, { recursive: true });
    }

    // Load existing index entries (preserve from previous runs)
    const indexPath = join(registryDir, 'index.yaml');
    const existing = new Map<string, RegistryEntry>();
    if (existsSync(indexPath)) {
      try {
        const prev = parseYaml(readFileSync(indexPath, 'utf-8')) as RegistryIndex;
        if (prev?.entries) {
          for (const entry of prev.entries) {
            existing.set(`${entry.name}@${entry.version}`, entry);
          }
        }
      } catch {
        // Ignore malformed index
      }
    }

    // Add/update entries from current results
    for (const result of this.results) {
      if (!result.success || !result.manifestPath) continue;
      if (!existsSync(result.manifestPath)) continue;

      try {
        const raw = readFileSync(result.manifestPath, 'utf-8');
        const manifest = parseYaml(raw) as Manifest;

        existing.set(`${result.name}@${result.version}`, {
          name: result.name,
          version: result.version,
          purl: manifest.package.purl,
          source_type: manifest.package.source_type,
          confidence: manifest.confidence,
          total_exports: manifest.exports.length,
        });
      } catch {
        // Skip malformed manifests
      }
    }

    const index: RegistryIndex = {
      schema_version: 1,
      generated: new Date().toISOString(),
      analyzer_version: GRAFEMA_VERSION,
      entries: [...existing.values()].sort((a, b) => a.name.localeCompare(b.name)),
    };

    writeFileSync(indexPath, stringifyYaml(index), 'utf-8');
    return indexPath;
  }

  /** Get all build results. */
  getResults(): BuildResult[] {
    return this.results;
  }

  /** Print summary table of build results. */
  printSummary(): void {
    const succeeded = this.results.filter(r => r.success);
    const failed = this.results.filter(r => !r.success);

    this.info(`\n${'─'.repeat(60)}`);
    this.info(`Registry build complete`);
    this.info(`  Succeeded: ${succeeded.length}`);
    this.info(`  Failed: ${failed.length}`);

    if (failed.length > 0) {
      this.info(`\nFailed packages:`);
      for (const r of failed) {
        this.info(`  ${r.name}: ${r.error}`);
      }
    }

    const totalDuration = this.results.reduce((sum, r) => sum + r.durationMs, 0);
    this.info(`\nTotal time: ${(totalDuration / 1000).toFixed(1)}s`);
  }

  // ── Private ────────────────────────────────────────────

  private getManifestDir(name: string, version: string): string {
    return join(this.options.registryDir, name, version);
  }

  private recordResult(
    name: string,
    version: string,
    success: boolean,
    error: string | undefined,
    startTime: number,
    manifestPath?: string,
  ): BuildResult {
    const result: BuildResult = {
      name,
      version,
      success,
      manifestPath,
      error,
      durationMs: Date.now() - startTime,
    };
    this.results.push(result);
    return result;
  }

  private async analyzeAndGenerate(
    packageName: string,
    version: string,
    packageDir: string,
    sourceType: ManifestPackage['source_type'],
    entryPoint: string | null,
  ): Promise<Manifest> {
    // Find orchestrator binary
    let orchestratorBinary = findOrchestratorBinary();
    if (!orchestratorBinary) {
      const downloaded = await ensureBinary('grafema-orchestrator', null, this.debug);
      if (downloaded) orchestratorBinary = downloaded;
    }
    if (!orchestratorBinary) {
      throw new Error('grafema-orchestrator binary not found');
    }

    // Create temp workspace (short path to avoid Unix socket 104-byte limit)
    const shortName = packageName.replace(/^@/, '').replace(/[/@]/g, '-').slice(0, 20);
    const tmpBase = join(tmpdir(), `gr-${shortName}-${Date.now() % 100000}`);
    const tmpGrafemaDir = join(tmpBase, '.grafema');
    const tmpDbPath = join(tmpGrafemaDir, 'graph.rfdb');

    mkdirSync(tmpGrafemaDir, { recursive: true });

    // Copy package to temp directory (avoids Rust glob issues with pnpm store paths
    // that contain @, +, and other special characters)
    const tmpPkgDir = join(tmpBase, 'pkg');
    cpSync(packageDir, tmpPkgDir, { recursive: true, filter: (src) => {
      // Skip node_modules WITHIN the package and .map files to save space
      // The src path starts with packageDir — only check the relative suffix
      const rel = src.slice(packageDir.length);
      if (rel.includes('node_modules')) return false;
      if (rel.endsWith('.map')) return false;
      return true;
    }});

    // Determine include patterns based on source type.
    // For compiled_js: prefer .js only (avoid analyzing both .js and .mjs copies)
    const includePatterns = sourceType === 'compiled_js'
      ? ['**/*.js', '**/*.cjs']
      : ['**/*.ts', '**/*.js', '**/*.mjs'];

    const excludePatterns = [
      '**/node_modules/**', '**/*.test.*', '**/*.spec.*',
      '**/test/**', '**/tests/**',
    ];

    // Count JS files to compute adaptive timeout
    const fileCount = countFilesRecursive(tmpPkgDir, includePatterns, excludePatterns);
    // Base 60s + 2s per file, minimum 60s, capped at user's max timeout
    const adaptiveTimeout = Math.min(
      Math.max(60_000, 60_000 + fileCount * 2_000),
      this.options.timeout,
    );
    this.debug(`  Files: ~${fileCount}, timeout: ${(adaptiveTimeout / 1000).toFixed(0)}s`);

    // Write temp config
    const configContent = stringifyYaml({
      root: tmpPkgDir,
      include: includePatterns,
      exclude: excludePatterns,
      plugins: [],
    });
    const configPath = join(tmpBase, 'grafema.config.yaml');
    writeFileSync(configPath, configContent, 'utf-8');

    // Start temp RFDB
    const backend = new RFDBServerBackend({
      dbPath: tmpDbPath,
      autoStart: true,
      silent: !this.options.verbose,
      clientName: 'registry',
    });

    try {
      await backend.connect();

      // Spawn orchestrator
      const exitCode = await this.spawnOrchestrator(
        orchestratorBinary,
        configPath,
        backend.socketPath,
        adaptiveTimeout,
      );

      if (exitCode !== 0) {
        throw new Error(`Orchestrator exited with code ${exitCode}`);
      }

      // Resolve effects-db path
      const effectsDbPath = this.resolveEffectsDbPath();

      // Normalize entry point (strip leading ./, ensure extension)
      let entryFile = entryPoint?.replace(/^\.\//, '');
      if (entryFile && !/\.\w+$/.test(entryFile)) {
        // No extension (e.g., "index") — append .js for compiled packages
        entryFile = `${entryFile}.js`;
      }

      // Generate manifest
      const purl = `pkg:npm/${packageName}@${version}`;
      const generator = new ManifestGenerator(backend, {
        purl,
        effectsDbPath,
        grafemaDir: tmpGrafemaDir,
        sourceType,
        entryFile,
      });

      return await generator.generate();
    } finally {
      // Cleanup
      if (backend.connected) {
        await backend.close();
      }
      // Remove temp directory
      try {
        rmSync(tmpBase, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup
      }
    }
  }

  private spawnOrchestrator(
    binary: string,
    configPath: string,
    socketPath: string,
    timeout?: number,
  ): Promise<number> {
    const effectiveTimeout = timeout ?? this.options.timeout;
    return new Promise((resolvePromise, reject) => {
      const args = ['analyze', '--config', configPath, '--socket', socketPath];

      this.debug(`  Spawning: ${binary} ${args.join(' ')}`);

      const child = spawn(binary, args, {
        stdio: ['ignore', this.options.verbose ? 'inherit' : 'ignore', this.options.verbose ? 'inherit' : 'ignore'],
        env: {
          ...process.env,
          RUST_LOG: this.options.verbose ? 'info' : 'warn',
        },
      });

      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`Analysis timed out after ${effectiveTimeout / 1000}s`));
      }, effectiveTimeout);

      child.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`Failed to spawn orchestrator: ${err.message}`));
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        resolvePromise(code ?? 1);
      });
    });
  }

  private resolveEffectsDbPath(): string | undefined {
    if (this.options.effectsDbPath && existsSync(this.options.effectsDbPath)) {
      return this.options.effectsDbPath;
    }

    // Try common locations
    const candidates = [
      join(this.options.projectPath, 'effects-db'),
      join(this.options.projectPath, '..', 'effects-db'),
    ];

    return candidates.find(p => existsSync(p));
  }
}

/** Count files matching include patterns (quick estimate for timeout calculation). */
function countFilesRecursive(dir: string, includes: string[], _excludes: string[]): number {
  const extensions = new Set<string>();
  for (const pattern of includes) {
    const match = pattern.match(/\*\.(\w+)$/);
    if (match) extensions.add(`.${match[1]}`);
  }
  if (extensions.size === 0) return 0;

  let count = 0;
  const walk = (d: string) => {
    try {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        const fullPath = join(d, entry.name);
        if (entry.isDirectory()) {
          // Skip excluded directories
          if (entry.name === 'node_modules' || entry.name === 'test' || entry.name === 'tests') continue;
          walk(fullPath);
        } else {
          const ext = entry.name.slice(entry.name.lastIndexOf('.'));
          if (extensions.has(ext) && !entry.name.includes('.test.') && !entry.name.includes('.spec.')) {
            count++;
          }
        }
      }
    } catch {
      // Ignore permission errors
    }
  };
  walk(dir);
  return count;
}
