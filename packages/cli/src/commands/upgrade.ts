import { Command } from 'commander';
import {
  existsSync, readdirSync, lstatSync, unlinkSync, rmSync,
  statSync, readFileSync, mkdirSync,
} from 'fs';
import { join, resolve } from 'path';
import {
  getGrafemaBinDir,
  DOWNLOADABLE_BINARIES,
  isBinaryCurrentVersion,
  downloadBinary,
  GRAFEMA_VERSION,
} from '@grafema/util';

const COLORS = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  reset: '\x1b[0m',
};

const LANG_BINARIES: Record<string, string[]> = {
  js:      ['grafema-analyzer', 'grafema-resolve'],
  python:  ['grafema-python-analyzer', 'python-resolve'],
  haskell: ['haskell-analyzer', 'haskell-resolve'],
  rust:    ['grafema-rust-resolve'],
  java:    ['grafema-java-analyzer', 'java-resolve', 'java-parser'],
  kotlin:  ['grafema-kotlin-analyzer', 'kotlin-resolve', 'kotlin-parser'],
  go:      ['grafema-go-analyzer', 'go-resolve', 'go-parser'],
  cpp:     ['grafema-cpp-analyzer', 'cpp-resolve'],
  swift:   ['grafema-swift-analyzer', 'swift-resolve', 'swift-parser'],
  objc:    ['grafema-objc-analyzer', 'objc-parser'],
  beam:    ['beam-analyzer', 'beam-resolve'],
};

const INFRASTRUCTURE = ['grafema-orchestrator', 'rfdb-server'];

const DOWNLOADABLE_SET = new Set(DOWNLOADABLE_BINARIES);

interface CleanAction {
  path: string;
  name: string;
  reason: string;
  size: number;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function auditBinDir(binDir: string): { toClean: CleanAction[]; knownBinaries: string[] } {
  const toClean: CleanAction[] = [];
  const knownBinaries: string[] = [];

  if (!existsSync(binDir)) return { toClean, knownBinaries };

  for (const entry of readdirSync(binDir)) {
    const fullPath = join(binDir, entry);
    let stat;
    try {
      stat = lstatSync(fullPath);
    } catch {
      continue;
    }

    if (stat.isSymbolicLink() && !existsSync(fullPath)) {
      toClean.push({ path: fullPath, name: entry, reason: 'broken symlink', size: 0 });
      continue;
    }

    if (entry.startsWith('.build-hash.') || entry.endsWith('.downloading')) {
      toClean.push({ path: fullPath, name: entry, reason: 'dev artifact', size: stat.size });
      continue;
    }

    if (entry.endsWith('.version')) {
      const binaryName = entry.slice(0, -'.version'.length);
      if (!existsSync(join(binDir, binaryName))) {
        toClean.push({ path: fullPath, name: entry, reason: 'orphaned version file', size: stat.size });
      }
      continue;
    }

    if (entry === '.gitkeep') continue;

    if (DOWNLOADABLE_SET.has(entry)) {
      knownBinaries.push(entry);
    } else {
      toClean.push({ path: fullPath, name: entry, reason: 'unknown binary', size: stat.size });
    }
  }

  return { toClean, knownBinaries };
}

function getTargetBinaries(
  options: { all?: boolean; lang?: string },
  existingBinaries: string[],
): string[] {
  if (options.all) {
    return [...DOWNLOADABLE_BINARIES];
  }

  if (options.lang) {
    const langs = options.lang.split(',').map(l => l.trim().toLowerCase());
    const invalid = langs.filter(l => !LANG_BINARIES[l]);
    if (invalid.length > 0) {
      console.error(`${COLORS.red}Unknown languages: ${invalid.join(', ')}${COLORS.reset}`);
      console.error(`Available: ${Object.keys(LANG_BINARIES).join(', ')}`);
      process.exit(1);
    }
    const bins = new Set<string>(INFRASTRUCTURE);
    for (const lang of langs) {
      for (const b of LANG_BINARIES[lang]) bins.add(b);
    }
    return [...bins];
  }

  const set = new Set<string>(existingBinaries);
  for (const b of INFRASTRUCTURE) set.add(b);
  return [...set];
}

function auditProjectDir(projectPath: string): CleanAction[] {
  const grafemaDir = join(projectPath, '.grafema');
  if (!existsSync(grafemaDir)) return [];

  const toClean: CleanAction[] = [];

  const diagLog = join(grafemaDir, 'diagnostics.log');
  if (existsSync(diagLog)) {
    toClean.push({ path: diagLog, name: 'diagnostics.log', reason: 'old diagnostics', size: statSync(diagLog).size });
  }

  const oldDb = join(grafemaDir, 'grafema.rfdb');
  const newDb = join(grafemaDir, 'graph.rfdb');
  if (existsSync(oldDb) && existsSync(newDb)) {
    let size = 0;
    try {
      for (const f of readdirSync(oldDb)) {
        try { size += statSync(join(oldDb, f)).size; } catch { /* skip */ }
      }
    } catch { /* skip */ }
    toClean.push({ path: oldDb, name: 'grafema.rfdb/', reason: 'stale database (renamed to graph.rfdb)', size });
  }

  const logsDir = join(grafemaDir, 'logs');
  if (existsSync(logsDir)) {
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    try {
      for (const f of readdirSync(logsDir)) {
        const fp = join(logsDir, f);
        try {
          const s = statSync(fp);
          if (s.isFile() && s.mtimeMs < thirtyDaysAgo) {
            toClean.push({ path: fp, name: `logs/${f}`, reason: 'log older than 30 days', size: s.size });
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  return toClean;
}

export const upgradeCommand = new Command('upgrade')
  .description('Clean stale artifacts and upgrade binaries to current version')
  .option('-a, --all', 'Download all available binaries (not just existing)')
  .option('-l, --lang <langs>', 'Comma-separated languages to install (js,python,rust,...)')
  .option('-n, --dry-run', 'Preview changes without executing')
  .option('-p, --project [path]', 'Also clean project .grafema/ artifacts')
  .addHelpText('after', `
Examples:
  grafema upgrade                  Clean + upgrade existing binaries
  grafema upgrade --all            Clean + download ALL available binaries
  grafema upgrade --lang js,python Clean + ensure JS and Python analyzers
  grafema upgrade --dry-run        Preview what would be cleaned/upgraded
  grafema upgrade --project        Also clean .grafema/ in current directory

Available languages: ${Object.keys(LANG_BINARIES).join(', ')}`)
  .action(async (options: { all?: boolean; lang?: string; dryRun?: boolean; project?: string | true }) => {
    const dryRun = !!options.dryRun;
    const prefix = dryRun ? `${COLORS.dim}[dry-run]${COLORS.reset} ` : '';
    const binDir = getGrafemaBinDir();

    console.log(`${COLORS.bold}Grafema Upgrade${COLORS.reset} ${COLORS.dim}v${GRAFEMA_VERSION}${COLORS.reset}`);
    console.log();

    if (!existsSync(binDir)) {
      mkdirSync(binDir, { recursive: true });
    }

    // Phase 1+2: Audit and clean ~/.grafema/bin/
    const { toClean, knownBinaries } = auditBinDir(binDir);

    if (toClean.length > 0) {
      console.log(`${COLORS.bold}Cleaning ~/.grafema/bin/${COLORS.reset}`);
      let cleanedBytes = 0;
      for (const item of toClean) {
        console.log(`  ${prefix}${COLORS.red}✗${COLORS.reset} ${item.name} ${COLORS.dim}(${item.reason}, ${formatBytes(item.size)})${COLORS.reset}`);
        if (!dryRun) {
          try {
            const s = lstatSync(item.path);
            if (s.isDirectory()) {
              rmSync(item.path, { recursive: true, force: true });
            } else {
              unlinkSync(item.path);
            }
            cleanedBytes += item.size;
          } catch (err) {
            console.log(`    ${COLORS.yellow}warning: ${err instanceof Error ? err.message : err}${COLORS.reset}`);
          }
        } else {
          cleanedBytes += item.size;
        }
      }
      console.log();
    }

    // Phase 3: Upgrade binaries
    const targets = getTargetBinaries(options, knownBinaries);

    console.log(`${COLORS.bold}Upgrading binaries${COLORS.reset} ${COLORS.dim}(target: binaries-v${GRAFEMA_VERSION})${COLORS.reset}`);

    let upgradedCount = 0;
    let currentCount = 0;
    let failedCount = 0;

    for (const name of targets) {
      const binaryPath = join(binDir, name);

      if (existsSync(binaryPath) && isBinaryCurrentVersion(binaryPath)) {
        currentCount++;
        console.log(`  ${COLORS.green}✓${COLORS.reset} ${name} ${COLORS.dim}-- current${COLORS.reset}`);
        continue;
      }

      if (dryRun) {
        const status = existsSync(binaryPath) ? 'stale, would upgrade' : 'missing, would download';
        console.log(`  ${prefix}${COLORS.cyan}↓${COLORS.reset} ${name} ${COLORS.dim}(${status})${COLORS.reset}`);
        upgradedCount++;
        continue;
      }

      try {
        process.stdout.write(`  ${COLORS.cyan}↓${COLORS.reset} ${name} -- downloading...`);
        const downloaded = await downloadBinary(name);
        const size = statSync(downloaded).size;
        process.stdout.write(`\r  ${COLORS.green}✓${COLORS.reset} ${name} ${COLORS.dim}(${formatBytes(size)})${COLORS.reset}          \n`);
        upgradedCount++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stdout.write(`\r  ${COLORS.red}✗${COLORS.reset} ${name} -- ${msg}          \n`);
        failedCount++;
      }
    }
    console.log();

    // Phase 4: Project cleanup (optional)
    let projectCleanedCount = 0;
    let projectCleanedBytes = 0;
    if (options.project !== undefined) {
      const projectPath = typeof options.project === 'string' ? resolve(options.project) : resolve('.');
      const projectActions = auditProjectDir(projectPath);
      if (projectActions.length > 0) {
        console.log(`${COLORS.bold}Cleaning project artifacts${COLORS.reset} ${COLORS.dim}(${projectPath}/.grafema/)${COLORS.reset}`);
        for (const item of projectActions) {
          console.log(`  ${prefix}${COLORS.red}✗${COLORS.reset} ${item.name} ${COLORS.dim}(${item.reason}, ${formatBytes(item.size)})${COLORS.reset}`);
          if (!dryRun) {
            try {
              const s = lstatSync(item.path);
              if (s.isDirectory()) {
                rmSync(item.path, { recursive: true, force: true });
              } else {
                unlinkSync(item.path);
              }
              projectCleanedCount++;
              projectCleanedBytes += item.size;
            } catch (err) {
              console.log(`    ${COLORS.yellow}warning: ${err instanceof Error ? err.message : err}${COLORS.reset}`);
            }
          } else {
            projectCleanedCount++;
            projectCleanedBytes += item.size;
          }
        }
        console.log();
      }
    }

    // Summary
    const parts: string[] = [];
    if (toClean.length > 0) {
      const totalCleaned = toClean.reduce((s, a) => s + a.size, 0);
      parts.push(`cleaned ${toClean.length} files (${formatBytes(totalCleaned)})`);
    }
    if (upgradedCount > 0) parts.push(`upgraded ${upgradedCount} binaries`);
    if (currentCount > 0) parts.push(`${currentCount} already current`);
    if (failedCount > 0) parts.push(`${COLORS.red}${failedCount} failed${COLORS.reset}`);
    if (projectCleanedCount > 0) parts.push(`project: ${projectCleanedCount} files (${formatBytes(projectCleanedBytes)})`);

    if (parts.length === 0) {
      console.log(`${COLORS.green}✓${COLORS.reset} Everything is up to date.`);
    } else {
      console.log(`${COLORS.bold}Summary:${COLORS.reset} ${parts.join(', ')}`);
    }
  });
