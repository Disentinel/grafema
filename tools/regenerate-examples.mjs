#!/usr/bin/env node
/**
 * regenerate-examples.mjs — capture stdout of `## Example` shell commands
 * embedded in `_ai/intents/<category>/<name>.md` sidecars.
 *
 * Usage:
 *   node tools/regenerate-examples.mjs [--project <path>] [--filter <glob>] [--max-lines N]
 *
 * For each sidecar with H2 sections, runs the first sh/bash/shell fence and
 * writes captured stdout into a sibling `<name>.captured.md` in the format
 * expected by `packages/util/src/exporters/intentLoader.ts#parseCaptured`.
 *
 * - Failures are non-fatal (exit code recorded, stderr logged).
 * - 60s per-command timeout.
 * - First-line `[RFDBServerBackend] Connected to ...` noise is filtered.
 * - Sidecars without a sh/bash fence are skipped silently.
 *
 * Pure Node ESM, only `node:` builtins, no deps.
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, basename, dirname } from 'node:path';

const COMMAND_TIMEOUT_MS = 60_000;
const NOISY_STDERR_PREFIX = '[RFDBServerBackend] Connected to ';

function localCliPath(projectRoot) {
  const cli = join(projectRoot, 'packages', 'cli', 'dist', 'cli.js');
  try { statSync(cli); return cli; } catch { return null; }
}

/**
 * Read sidecar frontmatter as a flat key/value map. Used only to detect the
 * `noCapture: true` opt-out — full YAML parsing lives in intentLoader.ts.
 */
function readFrontmatterFlags(sidecarPath) {
  let raw;
  try { raw = readFileSync(sidecarPath, 'utf8'); } catch { return {}; }
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.*?)\s*$/);
    if (kv) out[kv[1]] = kv[2];
  }
  return out;
}

function parseArgs(argv) {
  const out = { project: process.cwd(), filter: null, maxLines: 30 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project') out.project = resolve(argv[++i]);
    else if (a === '--filter') out.filter = argv[++i];
    else if (a === '--max-lines') out.maxLines = Number.parseInt(argv[++i], 10);
    else if (a === '--help' || a === '-h') {
      console.log('Usage: regenerate-examples.mjs [--project <path>] [--filter <glob>] [--max-lines N]');
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  if (!Number.isFinite(out.maxLines) || out.maxLines <= 0) out.maxLines = 30;
  return out;
}

/** Walk `_ai/intents/<category>/<name>.md` (excluding *.captured.md). */
function findSidecars(intentsRoot) {
  const sidecars = [];
  let categories;
  try {
    categories = readdirSync(intentsRoot);
  } catch {
    return sidecars;
  }
  for (const cat of categories) {
    const catDir = join(intentsRoot, cat);
    let st;
    try { st = statSync(catDir); } catch { continue; }
    if (!st.isDirectory()) continue;
    let entries;
    try { entries = readdirSync(catDir); } catch { continue; }
    for (const f of entries) {
      if (!f.endsWith('.md') || f.endsWith('.captured.md')) continue;
      sidecars.push({
        path: join(catDir, f),
        category: cat,
        name: f.slice(0, -3),
      });
    }
  }
  return sidecars;
}

/** Convert glob like `cli:command:t*` to a regex. Slugifies category like intentLoader. */
function compileFilter(glob) {
  if (!glob) return null;
  // Treat the user-facing glob `cli:command:tldr` as `cli-command/tldr` against our slug.
  // Convert ':' to either ':' (matches as-is in identifier) or '-' / '/'. To keep it simple,
  // accept BOTH ':' and '-' as separators by replacing them all to '-' in both target and glob.
  const normalize = (s) => s.replace(/:/g, '-').replace(/\//g, '-');
  const escaped = normalize(glob)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  const re = new RegExp(`^${escaped}$`);
  return (sidecar) => re.test(normalize(`${sidecar.category}-${sidecar.name}`));
}

/**
 * Parse H2 sections of a sidecar body. For each section, extract:
 *  - the first sh/bash/shell fence as `input`
 *  - the next plain fence (if any) — if it contains `{captured: <key>}` placeholder,
 *    the key is captured; otherwise the section title is used as key.
 *
 * Returns: [{ title, key, input }]
 */
function parseSidecarSections(raw) {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  // Skip frontmatter.
  let start = 0;
  if (lines[0] === '---') {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i] === '---') { start = i + 1; break; }
    }
  }

  const sections = [];
  let i = start;
  while (i < lines.length) {
    if (!lines[i].startsWith('## ')) { i++; continue; }
    const title = lines[i].slice(3).trim();
    i++;
    const body = [];
    while (i < lines.length && !lines[i].startsWith('## ')) {
      body.push(lines[i]);
      i++;
    }

    let input;
    let placeholderKey;
    for (let j = 0; j < body.length; j++) {
      const fenceMatch = body[j].match(/^```(\w*)/);
      if (!fenceMatch) continue;
      const lang = fenceMatch[1];
      const fenceStart = j + 1;
      let fenceEnd = fenceStart;
      while (fenceEnd < body.length && !body[fenceEnd].startsWith('```')) fenceEnd++;
      const code = body.slice(fenceStart, fenceEnd).join('\n').trimEnd();
      const isShell = lang === 'sh' || lang === 'bash' || lang === 'shell' || lang === 'console';
      if (input === undefined && isShell) {
        input = code;
      } else if (placeholderKey === undefined && !isShell) {
        const ph = code.match(/^\s*\{captured:\s*(\S+)\s*\}\s*$/);
        if (ph) placeholderKey = ph[1];
      }
      j = fenceEnd;
    }

    if (input !== undefined) {
      const key = placeholderKey ?? slugifyKey(title);
      sections.push({ title, key, input });
    }
  }
  return sections;
}

function slugifyKey(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'example';
}

/**
 * Run a shell command, return { ok, output }. Captures stdout, appends stderr
 * only if non-empty, drops first-line RFDB noise. On non-zero exit, output
 * is `[exit code N]` plus any stderr we got.
 */
function runCommand(cmd, projectRoot) {
  let stdout = '';
  let stderr = '';
  let exitCode = 0;
  // Resolve `grafema` to local CLI when running against the Grafema repo
  // itself (dogfood mode). Honour GRAFEMA_BIN override; otherwise look for
  // packages/cli/dist/cli.js relative to projectRoot.
  let cmdResolved = cmd;
  const grafemaBin = process.env.GRAFEMA_BIN ||
    ((s => (s ? `node ${s}` : null))(localCliPath(projectRoot)));
  if (grafemaBin) {
    cmdResolved = cmdResolved.replace(/(^|\s)grafema(\s|$)/g, `$1${grafemaBin}$2`);
  }
  try {
    stdout = execSync(cmdResolved, {
      cwd: projectRoot,
      timeout: COMMAND_TIMEOUT_MS,
      shell: '/bin/bash',
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString('utf8');
  } catch (err) {
    if (err && err.code === 'ETIMEDOUT') {
      return { ok: false, output: `[timeout after ${COMMAND_TIMEOUT_MS / 1000}s]`, timedOut: true };
    }
    exitCode = typeof err.status === 'number' ? err.status : 1;
    stdout = err.stdout ? err.stdout.toString('utf8') : '';
    stderr = err.stderr ? err.stderr.toString('utf8') : '';
  }

  // Try-after success path: also pull stderr if available (execSync returns only stdout buffer).
  // Filter noisy first stderr line.
  stderr = stderr
    .split('\n')
    .filter((line, idx) => !(idx === 0 && line.startsWith(NOISY_STDERR_PREFIX)))
    .join('\n');

  // Strip ANSI escape sequences (chalk-style colour codes) so captured docs
  // are clean text. Covers SGR (`\x1b[…m`), cursor motion and other CSI codes.
  // eslint-disable-next-line no-control-regex
  const ANSI_RE = /\x1B\[[0-?]*[ -/]*[@-~]/g;
  stdout = stdout.replace(ANSI_RE, '');
  stderr = stderr.replace(ANSI_RE, '');

  let output = stdout.replace(/\s+$/, '');
  if (stderr.trim()) {
    output = output ? `${output}\n${stderr.trimEnd()}` : stderr.trimEnd();
  }
  if (exitCode !== 0) {
    const marker = `[exit code ${exitCode}]`;
    output = output ? `${marker}\n${output}` : marker;
  }
  return { ok: exitCode === 0, output, timedOut: false };
}

function truncate(text, maxLines) {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;
  const kept = lines.slice(0, maxLines).join('\n');
  const remaining = lines.length - maxLines;
  return `${kept}\n... (truncated, ${remaining} more lines)`;
}

function buildCapturedMd(captures, fixtureLabel) {
  const today = new Date().toISOString().slice(0, 10);
  const parts = [
    `<!-- captured-at: ${today} -->`,
    `<!-- fixture: ${fixtureLabel} -->`,
    '',
  ];
  for (const c of captures) {
    parts.push(`## ${c.key}`);
    parts.push('```');
    parts.push(c.output);
    parts.push('```');
    parts.push('');
  }
  return parts.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const projectRoot = resolve(args.project);
  const intentsRoot = join(projectRoot, '_ai', 'intents');
  const filterFn = compileFilter(args.filter);

  const sidecars = findSidecars(intentsRoot).filter((s) => !filterFn || filterFn(s));
  if (sidecars.length === 0) {
    console.log('No sidecars matched.');
    return;
  }

  const startTime = Date.now();
  let totalExamples = 0;
  let featuresUpdated = 0;
  const fixtureLabel = relative(process.cwd(), projectRoot) || '.';

  for (const sc of sidecars) {
    let raw;
    try {
      raw = readFileSync(sc.path, 'utf8');
    } catch (err) {
      console.error(`Skipping ${sc.path}: ${err.message}`);
      continue;
    }
    const flags = readFrontmatterFlags(sc.path);
    if (flags.noCapture === 'true' || flags.noCapture === 'yes' || flags.noCapture === '1') {
      // Sidecar opted out — examples render without captured output.
      // Useful for destructive / long-running commands (analyze, check on
      // huge graphs) where running them at doc-regen time is impractical.
      continue;
    }
    const sections = parseSidecarSections(raw);
    if (sections.length === 0) continue;

    const captures = [];
    for (const section of sections) {
      const result = runCommand(section.input, projectRoot);
      if (result.timedOut) {
        console.warn(`Timeout: ${sc.category}/${sc.name} :: ${section.title}`);
        continue;
      }
      if (!result.ok) {
        console.error(`Non-zero exit: ${sc.category}/${sc.name} :: ${section.title}`);
      }
      const truncated = truncate(result.output, args.maxLines);
      captures.push({ key: section.key, output: truncated });
    }

    if (captures.length === 0) continue;

    const out = buildCapturedMd(captures, fixtureLabel === '.' ? 'this repo (Grafema itself)' : fixtureLabel);
    const targetPath = join(dirname(sc.path), `${sc.name}.captured.md`);
    writeFileSync(targetPath, out, 'utf8');
    totalExamples += captures.length;
    featuresUpdated += 1;
  }

  const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`captured ${totalExamples} examples across ${featuresUpdated} features in ${elapsedSec}s`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
