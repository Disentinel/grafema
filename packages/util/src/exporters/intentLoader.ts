/**
 * intentLoader — load human-authored intent sidecars for FEATURE snapshots.
 *
 * Sidecar layout:
 *   _ai/intents/<category-slug>/<name-slug>.md           — intent
 *   _ai/intents/<category-slug>/<name-slug>.captured.md  — captured outputs
 *
 * Slug rules:
 *   - category: ':' replaced with '-'  (so 'cli:command' → 'cli-command')
 *   - name:     surrounding ASCII quotes stripped, then non-[a-zA-Z0-9_-]
 *               characters replaced with '_'
 *
 * Frontmatter (YAML):
 *   whenToUse: |
 *     ...
 *   seeAlso:
 *     - cli:command:describe
 *   gotchas:
 *     - ...
 *
 * Body (Markdown):
 *   Optional H2 headings — each becomes one example. Code fences inside the
 *   section become input/output. The first ```sh / ```bash / ```shell fence
 *   is treated as input; the next plain ``` fence is treated as captured
 *   output. Captured-at metadata flows from a sibling .captured.md file
 *   (preferred) or from a `<!-- captured-at: 2026-04-27 -->` comment.
 *
 * Errors are non-fatal: missing sidecar → returns undefined; malformed
 * frontmatter / body → best-effort parse with warnings logged via the optional
 * `warn` callback.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, parse as parsePath, resolve, sep } from 'node:path';

import type { SpecedContractIntent, SpecedExample } from './types.js';

export interface LoadIntentOptions {
  /** Optional warn callback for sidecar parse issues. */
  warn?: (msg: string) => void;
}

/** Compute slug for an intent sidecar from category + name. */
export function intentSlug(category: string, name: string): { categoryDir: string; nameFile: string } {
  const categoryDir = category.replace(/:/g, '-');
  const stripped = stripQuotes(name);
  const nameFile = stripped.replace(/[^a-zA-Z0-9_-]/g, '_');
  return { categoryDir, nameFile };
}

function stripQuotes(s: string): string {
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === "'" || first === '"' || first === '`') && first === last) {
      return s.slice(1, -1);
    }
  }
  return s;
}

/**
 * Locate the project's `_ai/intents/` directory. Walks upward from the
 * starting directory until one is found, mirroring vscodeContributesExtractor.
 *
 * Return null if not found within 64 levels — Grafema project conventions
 * always place `_ai/` at the repo root.
 */
export function findIntentsRoot(startDir: string): string | null {
  const start = isAbsolute(startDir) ? startDir : resolve(startDir);
  const root = parsePath(start).root;
  let current = start;
  for (let i = 0; i < 64; i++) {
    const candidate = resolve(current, '_ai', 'intents');
    if (existsSync(candidate)) return candidate;
    if (current === root) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/**
 * Load the intent sidecar for a FEATURE. Returns undefined if no sidecar
 * exists (the common case until the project starts annotating).
 *
 * Pure read — never writes back.
 */
export function loadIntent(
  intentsRoot: string,
  category: string,
  name: string,
  options?: LoadIntentOptions,
): SpecedContractIntent | undefined {
  const { categoryDir, nameFile } = intentSlug(category, name);
  const sidecarPath = join(intentsRoot, categoryDir, `${nameFile}.md`);
  if (!existsSync(sidecarPath)) return undefined;

  let raw: string;
  try {
    raw = readFileSync(sidecarPath, 'utf8');
  } catch (err) {
    options?.warn?.(`intent: cannot read ${sidecarPath}: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }

  const { frontmatter, body } = splitFrontmatter(raw);
  const meta = parseFrontmatter(frontmatter);

  // Look for sibling .captured.md to pull example outputs.
  const capturedPath = join(intentsRoot, categoryDir, `${nameFile}.captured.md`);
  const capturedRaw = existsSync(capturedPath) ? safeRead(capturedPath, options) : null;
  const captured = capturedRaw ? parseCaptured(capturedRaw) : null;

  const examples = parseExamples(body, captured);

  const intent: SpecedContractIntent = {};
  if (typeof meta.whenToUse === 'string' && meta.whenToUse.trim()) intent.whenToUse = meta.whenToUse.trim();
  if (Array.isArray(meta.seeAlso) && meta.seeAlso.length > 0) intent.seeAlso = meta.seeAlso.filter(s => typeof s === 'string');
  if (Array.isArray(meta.gotchas) && meta.gotchas.length > 0) intent.gotchas = meta.gotchas.filter(s => typeof s === 'string');
  if (examples.length > 0) intent.examples = examples;

  // Empty intent (nothing populated) → return undefined to avoid noisy
  // empty sections in the renderer.
  if (
    intent.whenToUse === undefined &&
    intent.seeAlso === undefined &&
    intent.gotchas === undefined &&
    intent.examples === undefined
  ) {
    return undefined;
  }
  return intent;
}

function safeRead(path: string, options?: LoadIntentOptions): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    options?.warn?.(`intent: cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** Split a markdown file into YAML frontmatter (if any) and body. */
function splitFrontmatter(raw: string): { frontmatter: string; body: string } {
  // Match leading '---\n...\n---' block (with either \n or \r\n line endings).
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (m) return { frontmatter: m[1], body: m[2] };
  return { frontmatter: '', body: raw };
}

/**
 * Tiny YAML-subset parser — supports `key: scalar`, `key: |\n  block\n`,
 * `key:\n  - list-item`. Doesn't pretend to handle full YAML; sidecars are
 * project-controlled so the format is well-known.
 */
function parseFrontmatter(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) { i++; continue; }
    const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.*)$/);
    if (!m) { i++; continue; }
    const key = m[1];
    const inline = m[2];

    if (inline === '|' || inline === '|-' || inline === '>' || inline === '>-') {
      // Block scalar — read indented lines until dedent.
      i++;
      const block: string[] = [];
      while (i < lines.length) {
        const cur = lines[i];
        if (cur.length === 0) { block.push(''); i++; continue; }
        if (/^[ \t]/.test(cur)) {
          block.push(cur.replace(/^ {0,2}/, ''));
          i++;
        } else {
          break;
        }
      }
      const fold = inline.startsWith('>');
      out[key] = fold ? block.join(' ').trim() : block.join('\n').trimEnd();
      continue;
    }

    if (inline === '') {
      // Possible list under this key. List items may span multiple lines —
      // any indented continuation (no leading '-') is appended to the
      // previous item with a single space, mirroring how a sentence wraps.
      i++;
      const items: string[] = [];
      while (i < lines.length) {
        const cur = lines[i];
        if (!cur.trim()) { i++; continue; }
        const lm = cur.match(/^\s*-\s+(.+)$/);
        if (lm) {
          items.push(stripScalar(lm[1]));
          i++;
          continue;
        }
        const cont = cur.match(/^\s+(\S.*)$/);
        if (cont && items.length > 0) {
          items[items.length - 1] = `${items[items.length - 1]} ${stripScalar(cont[1])}`.trim();
          i++;
          continue;
        }
        break;
      }
      out[key] = items;
      continue;
    }

    // Inline scalar.
    out[key] = stripScalar(inline);
    i++;
  }
  return out;
}

function stripScalar(v: string): string {
  let s = v.trim();
  // Strip surrounding quotes if any.
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === '"' || first === "'") && first === last) s = s.slice(1, -1);
  }
  // Strip trailing inline comment.
  s = s.replace(/\s+#.*$/, '');
  return s;
}

/**
 * Walk the body looking for H2 sections. Each section yields one example.
 * Within a section, the first shell fence is the input; the first plain
 * fence is treated as inline-captured output (legacy fallback if no sibling
 * .captured.md exists).
 */
function parseExamples(body: string, captured: Map<string, string> | null): SpecedExample[] {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const examples: SpecedExample[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.startsWith('## ')) { i++; continue; }
    const title = line.slice(3).trim();

    // Collect section body until next H2 / EOF.
    const section: string[] = [];
    i++;
    while (i < lines.length && !lines[i].startsWith('## ')) {
      section.push(lines[i]);
      i++;
    }

    // Extract first shell fence as input, first non-shell fence as output.
    let input: string | undefined;
    let output: string | undefined;
    let capturedKey: string | undefined;

    for (let j = 0; j < section.length; j++) {
      const fenceMatch = section[j].match(/^```(\w*)/);
      if (!fenceMatch) continue;
      const lang = fenceMatch[1];
      const start = j + 1;
      let end = start;
      while (end < section.length && !section[end].startsWith('```')) end++;
      const code = section.slice(start, end).join('\n').trimEnd();
      if (input === undefined && (lang === 'sh' || lang === 'bash' || lang === 'shell' || lang === 'console')) {
        input = code;
      } else if (output === undefined && lang !== 'sh' && lang !== 'bash' && lang !== 'shell' && lang !== 'console') {
        output = code;
      }
      j = end;
    }

    // Allow `{captured: <key>}` placeholder inside a fence — pull from sibling.
    if (output && captured) {
      const ph = output.match(/^\s*\{captured:\s*(\S+)\s*\}\s*$/);
      if (ph) {
        capturedKey = ph[1];
        const real = captured.get(capturedKey);
        if (real !== undefined) output = real;
      }
    }

    if (input !== undefined) {
      const ex: SpecedExample = { input };
      if (output !== undefined) ex.output = output;
      if (title) ex.title = title;
      if (capturedKey && captured?.has(`${capturedKey}@capturedAt`)) {
        ex.capturedAt = captured.get(`${capturedKey}@capturedAt`);
      }
      examples.push(ex);
    }
  }
  return examples;
}

/**
 * Parse a sibling `.captured.md` file. Format:
 *
 *   <!-- captured-at: 2026-04-27 -->
 *   ## example-1
 *   ```
 *   ...output...
 *   ```
 *   ## example-2
 *   ```
 *   ...
 *   ```
 *
 * Returns a Map keyed by section title; capturedAt timestamp is stored
 * under `<key>@capturedAt`.
 */
function parseCaptured(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const tsMatch = raw.match(/<!--\s*captured-at:\s*(\S+?)\s*-->/);
  const ts = tsMatch ? tsMatch[1] : undefined;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.startsWith('## ')) { i++; continue; }
    const key = line.slice(3).trim();
    i++;
    // Find next fence.
    while (i < lines.length && !lines[i].startsWith('```')) i++;
    if (i >= lines.length) break;
    i++;
    const body: string[] = [];
    while (i < lines.length && !lines[i].startsWith('```')) {
      body.push(lines[i]);
      i++;
    }
    out.set(key, body.join('\n').trimEnd());
    if (ts) out.set(`${key}@capturedAt`, ts);
    i++;
  }
  return out;
}

/** Convenience: convert sidecar path components for tests / introspection. */
export function intentSidecarPath(intentsRoot: string, category: string, name: string): string {
  const { categoryDir, nameFile } = intentSlug(category, name);
  return [intentsRoot, categoryDir, `${nameFile}.md`].join(sep);
}
