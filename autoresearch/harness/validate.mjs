#!/usr/bin/env node
/**
 * Autoresearch question staleness checker.
 *
 * Verifies that anchor patterns in questions.yaml still match files on disk.
 * If an anchor's grep pattern is not found, the question is stale.
 *
 * Usage:
 *   node autoresearch/harness/validate.mjs [--questions autoresearch/questions.yaml]
 */

import { readFileSync } from 'fs';
import { resolve, join } from 'path';
import { execSync } from 'child_process';
import { createRequire } from 'module';

const _require = createRequire(join(resolve(new URL('../../', import.meta.url).pathname), 'packages', 'util', 'package.json'));
const { parse: parseYAML } = _require('yaml');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROJECT_ROOT = resolve(new URL('../../', import.meta.url).pathname);
const DEFAULT_QUESTIONS = join(PROJECT_ROOT, 'autoresearch', 'questions.yaml');

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    questions: DEFAULT_QUESTIONS,
  };
  let i = 2;
  while (i < argv.length) {
    switch (argv[i]) {
      case '--questions':
        args.questions = resolve(argv[++i]);
        break;
      case '--help':
      case '-h':
        console.error('Usage: node validate.mjs [--questions autoresearch/questions.yaml]');
        process.exit(0);
        break;
      default:
        console.error(`Unknown argument: ${argv[i]}`);
        process.exit(1);
    }
    i++;
  }
  return args;
}

// ---------------------------------------------------------------------------
// YAML helpers
// ---------------------------------------------------------------------------

function loadQuestions(path) {
  const raw = readFileSync(path, 'utf8');
  const data = parseYAML(raw);
  return Array.isArray(data) ? data : data.questions;
}

// ---------------------------------------------------------------------------
// Anchor validation
// ---------------------------------------------------------------------------

/**
 * Check if a grep pattern matches within a file glob.
 * Returns { found: boolean, detail: string }.
 *
 * Handles glob patterns like "packages/mcp/src/**\/*.ts" by extracting
 * the directory prefix and file extension for grep --include.
 */
function checkAnchor(anchor) {
  const { pattern, file } = anchor;
  if (!pattern || !file) {
    return { found: false, detail: 'anchor missing pattern or file field' };
  }

  try {
    // Extract directory part (before any glob wildcard) and file extension
    const parts = file.split(/[*{]/);
    const dir = parts[0].replace(/\/+$/, '') || '.';

    // Extract --include pattern from the glob (e.g., "*.ts" from "**/*.ts")
    const extMatch = file.match(/\*\.(\w+)$/);
    const includeArg = extMatch ? `--include=${shellEscape('*.' + extMatch[1])}` : '';

    const cmd = `grep -rl --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.grafema ${includeArg} ${shellEscape(pattern)} ${shellEscape(dir)} 2>/dev/null`;
    const result = execSync(cmd, {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      timeout: 10000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const matchedFiles = result.trim().split('\n').filter(Boolean);
    if (matchedFiles.length > 0) {
      return { found: true, detail: `"${pattern}" found in ${matchedFiles[0]}` };
    }
    return { found: false, detail: `"${pattern}" NOT found in ${file}` };
  } catch {
    // grep returns exit code 1 when no matches
    return { found: false, detail: `"${pattern}" NOT found in ${file}` };
  }
}

function shellEscape(s) {
  // Wrap in single quotes, escape any internal single quotes
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv);
  const questions = loadQuestions(args.questions);

  let totalWithAnchors = 0;
  let valid = 0;
  let stale = 0;
  const staleQuestions = [];

  for (const q of questions) {
    const anchors = q.anchors;
    if (!anchors || anchors.length === 0) {
      // No anchors — skip
      continue;
    }

    totalWithAnchors++;
    let allFound = true;

    for (const anchor of anchors) {
      const result = checkAnchor(anchor);
      if (result.found) {
        console.log(`${q.id}: valid (anchor: ${result.detail})`);
      } else {
        console.log(`${q.id}: STALE (anchor: ${result.detail})`);
        allFound = false;
      }
    }

    if (allFound) {
      valid++;
    } else {
      stale++;
      staleQuestions.push(q.id);
    }
  }

  console.log('');
  console.log(`Summary: ${valid}/${totalWithAnchors} valid, ${stale} stale`);
  if (staleQuestions.length > 0) {
    console.log(`Stale questions: ${staleQuestions.join(', ')}`);
  }

  // Exit code 1 if any stale
  process.exit(stale > 0 ? 1 : 0);
}

main();
