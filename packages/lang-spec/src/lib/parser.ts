/**
 * Corpus parser — extracts @construct blocks from source files.
 *
 * Pure deterministic logic with no LLM calls.
 *
 * Provides:
 * - `parseFile()` — parse a single source file into Construct objects
 * - `parseCorpusDir()` — parse all source files in a corpus directory
 * - `writeNdjson()` — serialize an array as NDJSON
 * - `readNdjson()` — deserialize NDJSON file into an array
 */

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import type { Construct } from '../types.js';

/** File extensions recognized as corpus source files */
const SOURCE_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.py', '.pyw',
]);

/** Map file extension to single-line comment prefix */
function getCommentPrefix(ext: string): string {
  switch (ext) {
    case '.py':
    case '.pyw':
      return '#';
    default:
      return '//';
  }
}

/** Determine moduleType from file extension */
function getModuleType(ext: string): string | undefined {
  switch (ext) {
    case '.cjs':
      return 'cjs';
    case '.mjs':
      return 'esm';
    default:
      return undefined;
  }
}

/**
 * Parse a single source file, extracting all @construct blocks.
 *
 * Each block starts at a `{commentPrefix} @construct PENDING|APPROVED tag-name` line
 * and ends at the next @construct marker, section header, or EOF.
 *
 * @param filePath - Absolute path to the source file
 * @param corpusDir - Absolute path to the corpus root (for relative path calculation)
 * @returns Array of parsed Construct objects
 */
export function parseFile(filePath: string, corpusDir: string): Construct[] {
  const content = readFileSync(filePath, 'utf-8');
  return parseFileContent(content, filePath, corpusDir);
}

/**
 * Parse a single source file asynchronously.
 *
 * @param filePath - Absolute path to the source file
 * @param corpusDir - Absolute path to the corpus root
 * @returns Array of parsed Construct objects
 */
export async function parseFileAsync(
  filePath: string,
  corpusDir: string,
): Promise<Construct[]> {
  const content = await readFile(filePath, 'utf-8');
  return parseFileContent(content, filePath, corpusDir);
}

/**
 * Parse file content into Construct objects.
 *
 * Exported for testing — allows parsing without file I/O.
 *
 * @param content - Raw file content
 * @param filePath - Absolute path to the file (for metadata)
 * @param corpusDir - Absolute path to corpus root (for relative path)
 * @returns Array of parsed Construct objects
 */
export function parseFileContent(
  content: string,
  filePath: string,
  corpusDir: string,
): Construct[] {
  const ext = extname(filePath);
  const commentPrefix = getCommentPrefix(ext);
  const moduleType = getModuleType(ext);
  const relativePath = filePath.startsWith(corpusDir)
    ? filePath.slice(corpusDir.length).replace(/^\//, '')
    : filePath;
  const category = basename(filePath, ext);

  const lines = content.split('\n');
  const markerPattern = new RegExp(
    `^\\s*${escapeRegex(commentPrefix)}\\s+@construct\\s+(PENDING|APPROVED)\\s+(.+)$`,
  );
  const sectionHeaderPattern = /^\/\/\s*={3,}/;

  // Find all @construct marker positions
  const markers: Array<{
    lineIndex: number;
    status: string;
    tag: string;
  }> = [];

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(markerPattern);
    if (match) {
      markers.push({
        lineIndex: i,
        status: match[1],
        tag: match[2].trim(),
      });
    }
  }

  if (markers.length === 0) {
    return [];
  }

  // Track duplicate tags for suffix generation
  const tagCounts = new Map<string, number>();
  const constructs: Construct[] = [];

  for (let m = 0; m < markers.length; m++) {
    const marker = markers[m];
    const nextMarkerLine = m + 1 < markers.length ? markers[m + 1].lineIndex : lines.length;

    // Extract code lines: everything after the marker line until next marker or EOF
    // Exclude trailing blank lines and section headers
    const blockLines: string[] = [];
    let codeStarted = false;

    for (let i = marker.lineIndex + 1; i < nextMarkerLine; i++) {
      const line = lines[i];

      // Skip section headers between constructs
      if (sectionHeaderPattern.test(line)) {
        continue;
      }

      // Before code starts, skip comment-only preamble lines (lines that are
      // only a comment and not part of the code block)
      if (!codeStarted) {
        const trimmed = line.trim();
        if (trimmed === '') continue;
        // A line that starts with comment prefix but is not a code line
        // is considered preamble only if it looks like a description comment
        // (not a commented-out code line). We start code at the first
        // non-empty line after the marker.
        codeStarted = true;
      }

      blockLines.push(line);
    }

    // Trim trailing blank lines
    while (blockLines.length > 0 && blockLines[blockLines.length - 1].trim() === '') {
      blockLines.pop();
    }

    if (blockLines.length === 0) {
      continue;
    }

    const code = blockLines.join('\n');

    // Detect commentedOut: all non-empty code lines start with comment prefix
    const nonEmptyLines = blockLines.filter((l) => l.trim().length > 0);
    const commentedOut =
      nonEmptyLines.length > 0 &&
      nonEmptyLines.every((l) => l.trimStart().startsWith(commentPrefix));

    // Generate unique ID with dedup suffix
    const baseTag = marker.tag;
    const count = tagCounts.get(baseTag) ?? 0;
    tagCounts.set(baseTag, count + 1);

    const tag = count === 0 ? baseTag : `${baseTag}-${count}`;
    const id = `${category}::${tag}`;

    // Calculate 1-based line numbers
    const lineStart = marker.lineIndex + 1; // marker line itself (1-based)
    const codeFirstLineIndex = lines.indexOf(blockLines[0], marker.lineIndex + 1);
    const codeLastLineIndex = codeFirstLineIndex + blockLines.length - 1;
    const lineEnd = codeLastLineIndex + 1; // 1-based

    const construct: Construct = {
      id,
      file: relativePath,
      category,
      lineStart,
      lineEnd,
      code,
      commentedOut,
    };

    if (moduleType !== undefined) {
      construct.moduleType = moduleType;
    }

    constructs.push(construct);
  }

  return constructs;
}

/**
 * Parse all source files in a corpus directory.
 *
 * Scans `{corpusDir}/src/` for recognized source file extensions,
 * parses each file, and returns all constructs sorted by file then lineStart.
 *
 * @param corpusDir - Absolute path to the corpus root directory
 * @returns Array of all parsed Construct objects, sorted by file then lineStart
 */
export async function parseCorpusDir(corpusDir: string): Promise<Construct[]> {
  const srcDir = join(corpusDir, 'src');
  const entries = await readdir(srcDir, { withFileTypes: true });

  const sourceFiles = entries
    .filter((entry: { isFile: () => boolean; name: string }) =>
      entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name)),
    )
    .map((entry: { name: string }) => join(srcDir, entry.name))
    .sort();

  const allConstructs: Construct[] = [];

  for (const filePath of sourceFiles) {
    const constructs = await parseFileAsync(filePath, corpusDir);
    allConstructs.push(...constructs);
  }

  // Sort by file path, then by lineStart
  allConstructs.sort((a, b) => {
    const fileCmp = a.file.localeCompare(b.file);
    if (fileCmp !== 0) return fileCmp;
    return a.lineStart - b.lineStart;
  });

  return allConstructs;
}

/**
 * Write an array of objects as NDJSON (newline-delimited JSON).
 *
 * Each element is serialized as a single JSON line.
 *
 * @param constructs - Array of objects to serialize
 * @param outputPath - Absolute path to the output file
 */
export async function writeNdjson<T>(
  items: T[],
  outputPath: string,
): Promise<void> {
  const content = items.map((item) => JSON.stringify(item)).join('\n') + '\n';
  await writeFile(outputPath, content, 'utf-8');
}

/**
 * Read an NDJSON file and parse each line into a typed object.
 *
 * Skips empty lines. Throws on malformed JSON.
 *
 * @param path - Absolute path to the NDJSON file
 * @returns Array of parsed objects
 */
export async function readNdjson<T>(path: string): Promise<T[]> {
  const content = await readFile(path, 'utf-8');
  const lines = content.split('\n').filter((line: string) => line.trim().length > 0);
  return lines.map((line: string) => JSON.parse(line) as T);
}

// --- Internal helpers ---

/** Escape special regex characters in a string */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
