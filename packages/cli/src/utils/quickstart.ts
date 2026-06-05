/**
 * Shared utilities for project initialization and quickstart.
 *
 * Used by both `grafema init` and `grafema analyze --quickstart`.
 */

import { join } from 'path';
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'fs';
import { stringify as stringifyYAML } from 'yaml';
import { GRAFEMA_VERSION, getSchemaVersion } from '@grafema/util';

/** All file extensions supported by Grafema's analyzers. */
export const SUPPORTED_EXTENSIONS = [
  // JavaScript / TypeScript
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx',
  // Rust
  'rs',
  // Java / Kotlin
  'java', 'kt', 'kts',
  // Python
  'py', 'pyi',
  // Go
  'go',
  // Haskell
  'hs',
  // C / C++
  'c', 'h', 'cpp', 'hpp', 'cc', 'cxx', 'hxx', 'hh', 'inl', 'ipp', 'tpp', 'txx',
  // Swift / Objective-C
  'swift', 'm', 'mm',
  // BEAM (Elixir / Erlang)
  'ex', 'exs', 'erl', 'hrl',
  // Lean 4
  'lean',
];

/** Directories to skip during project scanning. */
const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'build', 'target', 'vendor',
  '.git', '.grafema', 'coverage', '.next', '.nuxt',
  '__pycache__', '.tox', '.venv',
]);

const SUPPORTED_SET = new Set(SUPPORTED_EXTENSIONS);
const MAX_DEPTH = 10;
const MAX_FILES = 50_000;

/**
 * Scan a project directory for supported file extensions.
 * Returns a Map of extension → file count for detected extensions.
 */
export function scanExtensions(projectPath: string): Map<string, number> {
  const counts = new Map<string, number>();
  let filesScanned = 0;

  function walk(dir: string, depth: number): void {
    if (depth > MAX_DEPTH || filesScanned >= MAX_FILES) return;

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // Permission denied or similar — skip
    }

    for (const entry of entries) {
      if (filesScanned >= MAX_FILES) return;

      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
          walk(join(dir, entry.name), depth + 1);
        }
      } else if (entry.isFile()) {
        filesScanned++;
        const dot = entry.name.lastIndexOf('.');
        if (dot !== -1) {
          const ext = entry.name.slice(dot + 1);
          if (SUPPORTED_SET.has(ext)) {
            counts.set(ext, (counts.get(ext) ?? 0) + 1);
          }
        }
      }
    }
  }

  walk(projectPath, 0);
  return counts;
}

/**
 * Generate config YAML content.
 *
 * If `detectedExtensions` is provided and non-empty, only includes those extensions.
 * Otherwise falls back to all supported extensions (same as `grafema init`).
 */
export function generateSmartConfig(detectedExtensions?: Map<string, number>): string {
  const exts = (detectedExtensions && detectedExtensions.size > 0)
    ? [...detectedExtensions.keys()]
    : SUPPORTED_EXTENSIONS;

  const extensions = `*.{${exts.join(',')}}`;
  const config = {
    version: getSchemaVersion(GRAFEMA_VERSION),
    root: '..',
    include: [`**/${extensions}`],
    exclude: [
      '**/*.test.*',
      '**/__tests__/**',
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/target/**',
      '**/vendor/**',
      '**/.git/**',
    ],
  };

  const yaml = stringifyYAML(config, {
    lineWidth: 0,
  });

  return `# Grafema Configuration
# Documentation: https://github.com/grafema/grafema#configuration
# Supported: JS/TS, Rust, Java, Kotlin, Python, Go, Haskell, C/C++, Swift, Elixir/Erlang

${yaml}
# services:  # Explicit service definitions (overrides auto-discovery)
#   - name: "api"
#     path: "."
#     entryPoint: "src/index.ts"
`;
}

/**
 * Write config file to .grafema/config.yaml, creating the directory if needed.
 */
export function writeConfig(projectPath: string, configContent: string): void {
  const grafemaDir = join(projectPath, '.grafema');
  if (!existsSync(grafemaDir)) {
    mkdirSync(grafemaDir, { recursive: true });
  }
  writeFileSync(join(grafemaDir, 'config.yaml'), configContent);
}

/**
 * Add Grafema entries to .gitignore if it exists and doesn't already have them.
 */
export function updateGitignore(projectPath: string): boolean {
  const gitignorePath = join(projectPath, '.gitignore');
  if (existsSync(gitignorePath)) {
    const gitignore = readFileSync(gitignorePath, 'utf-8');
    if (!gitignore.includes('.grafema/graph.rfdb')) {
      writeFileSync(
        gitignorePath,
        gitignore + '\n# Grafema\n.grafema/graph.rfdb\n.grafema/rfdb.sock\n'
      );
      return true;
    }
  }
  return false;
}

/** Map of extension to human-readable language name. */
const EXT_LANGUAGE: Record<string, string> = {
  js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
  ts: 'TypeScript', tsx: 'TypeScript',
  rs: 'Rust',
  java: 'Java', kt: 'Kotlin', kts: 'Kotlin',
  py: 'Python', pyi: 'Python',
  go: 'Go',
  hs: 'Haskell',
  c: 'C', h: 'C/C++', cpp: 'C++', hpp: 'C++', cc: 'C++', cxx: 'C++', hxx: 'C++', hh: 'C++',
  inl: 'C++', ipp: 'C++', tpp: 'C++', txx: 'C++',
  swift: 'Swift', m: 'Objective-C', mm: 'Objective-C++',
  ex: 'Elixir', exs: 'Elixir', erl: 'Erlang', hrl: 'Erlang',
};

/**
 * Format detected extensions as a human-readable string.
 * Groups by language and shows total file count per language.
 *
 * Example: "TypeScript (342 files), JavaScript (18 files), Python (5 files)"
 */
export function formatDetected(detected: Map<string, number>): string {
  // Group counts by language
  const langCounts = new Map<string, number>();
  for (const [ext, count] of detected) {
    const lang = EXT_LANGUAGE[ext] ?? ext;
    langCounts.set(lang, (langCounts.get(lang) ?? 0) + count);
  }

  // Sort by count descending
  const sorted = [...langCounts.entries()].sort((a, b) => b[1] - a[1]);
  return sorted.map(([lang, count]) => `${lang} (${count} files)`).join(', ');
}
