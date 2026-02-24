/**
 * Stage 07 — Writeback
 *
 * Inserts annotation comments into source files between the @construct
 * marker and the code. Deterministic stage (no LLM).
 *
 * Merges GREEN constructs from pass 1 with reannotated YELLOW/RED from
 * pass 2, then writes structured annotation blocks into the corpus
 * source files.
 *
 * Input:  {corpusDir}/.pipeline/02-triaged.ndjson   (GREEN from pass 1)
 *         {corpusDir}/.pipeline/04-reannotated.ndjson (YELLOW + RED from pass 2)
 * Output: Modified corpus source files with @annotation blocks
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { readNdjson } from '../lib/parser.js';
import type { AnnotatedConstruct, TriagedConstruct } from '../types.js';

/** Determine the single-line comment prefix for a file extension. */
function commentPrefix(ext: string): string {
  switch (ext) {
    case '.py':
    case '.rb':
    case '.sh':
    case '.bash':
    case '.zsh':
    case '.yaml':
    case '.yml':
      return '#';
    default:
      return '//';
  }
}

/**
 * Format metadata object as compact inline representation.
 * Example: {key: value, key2: value2}
 */
function formatMetadata(metadata: Record<string, unknown>): string {
  const entries = Object.entries(metadata);
  if (entries.length === 0) return '';
  const parts = entries.map(([k, v]) => {
    const val = typeof v === 'string' ? v : JSON.stringify(v);
    return `${k}: ${val}`;
  });
  return ` {${parts.join(', ')}}`;
}

/**
 * Build the annotation comment block for a construct.
 *
 * Format:
 *   // @annotation
 *   // NODE_TYPE <id> {metadata}
 *   // SRC_TYPE <srcId> -> EDGE_TYPE -> DST_TYPE <dstId>
 *   // @end-annotation
 */
function buildAnnotationBlock(
  ac: AnnotatedConstruct,
  prefix: string,
): string[] {
  const lines: string[] = [];
  lines.push(`${prefix} @annotation`);

  // Build a lookup from node ID to node
  const nodeById = new Map(ac.annotation.nodes.map((n) => [n.id, n]));

  // Track which nodes are fully described by edge lines (appear as src or dst)
  const nodesInEdges = new Set<string>();
  for (const edge of ac.annotation.edges) {
    nodesInEdges.add(edge.src);
    nodesInEdges.add(edge.dst);
  }

  // Standalone node lines: nodes not appearing in any edge
  for (const node of ac.annotation.nodes) {
    if (!nodesInEdges.has(node.id)) {
      let line = `${prefix} ${node.type} <${node.id}>`;
      if (node.metadata && Object.keys(node.metadata).length > 0) {
        line += formatMetadata(node.metadata);
      }
      lines.push(line);
    }
  }

  // Edge lines
  for (const edge of ac.annotation.edges) {
    const srcNode = nodeById.get(edge.src);
    const dstNode = nodeById.get(edge.dst);
    const srcType = srcNode?.type ?? 'UNKNOWN';
    const dstType = dstNode?.type ?? 'UNKNOWN';
    lines.push(
      `${prefix} ${srcType} <${edge.src}> -> ${edge.type} -> ${dstType} <${edge.dst}>`,
    );
  }

  lines.push(`${prefix} @end-annotation`);
  return lines;
}

/**
 * Remove an existing @annotation...@end-annotation block from lines.
 *
 * Returns the lines with the annotation block removed, searching
 * only in the region immediately after the @construct marker.
 *
 * @param lines - All lines of the file
 * @param constructLineIdx - 0-based index of the @construct line
 * @param prefix - Comment prefix for this file type
 * @returns Updated lines array (may be shorter if block was removed)
 */
function removeExistingAnnotation(
  lines: string[],
  constructLineIdx: number,
  prefix: string,
): string[] {
  const startMarker = `${prefix} @annotation`;
  const endMarker = `${prefix} @end-annotation`;

  // Search for annotation block in the lines immediately following the construct marker
  let blockStart = -1;
  let blockEnd = -1;

  for (let i = constructLineIdx + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === startMarker.trim()) {
      blockStart = i;
      break;
    }
    // Stop searching if we hit a non-comment, non-empty line (the code itself)
    if (trimmed !== '' && !trimmed.startsWith(prefix.trim())) {
      break;
    }
  }

  if (blockStart !== -1) {
    for (let i = blockStart; i < lines.length; i++) {
      if (lines[i].trim() === endMarker.trim()) {
        blockEnd = i;
        break;
      }
    }
  }

  if (blockStart !== -1 && blockEnd !== -1) {
    lines.splice(blockStart, blockEnd - blockStart + 1);
  }

  return lines;
}

/**
 * Insert annotation comments into corpus source files.
 *
 * Merges GREEN constructs from pass 1 triage with reannotated
 * YELLOW/RED constructs from pass 2, then writes @annotation blocks
 * into each source file between the @construct marker and the code.
 *
 * Files are processed bottom-to-top (highest lineStart first) so
 * that line insertions do not shift the positions of earlier constructs.
 *
 * @param corpusDir - Path to the corpus directory
 */
export async function writebackAnnotations(corpusDir: string): Promise<void> {
  // Read GREEN constructs from triage (pass 1 only)
  const triaged = await readNdjson<TriagedConstruct>(
    join(corpusDir, '.pipeline', '02-triaged.ndjson'),
  );
  const greenPass1 = triaged.filter(
    (tc) => tc.triage.color === 'GREEN' && tc.pass === 1,
  );

  // Read reannotated constructs (pass 2: YELLOW + RED after human/LLM review)
  let reannotated: AnnotatedConstruct[] = [];
  try {
    reannotated = await readNdjson<AnnotatedConstruct>(
      join(corpusDir, '.pipeline', '04-reannotated.ndjson'),
    );
  } catch {
    // No reannotated file is valid (e.g., all constructs were GREEN)
  }

  // Merge: prefer pass 2 if same construct ID exists in both
  const merged = new Map<string, AnnotatedConstruct>();
  for (const gc of greenPass1) {
    merged.set(gc.construct.id, gc);
  }
  for (const rc of reannotated) {
    merged.set(rc.construct.id, rc);
  }

  // Group by file
  const byFile = new Map<string, AnnotatedConstruct[]>();
  for (const ac of merged.values()) {
    const file = ac.construct.file;
    let list = byFile.get(file);
    if (!list) {
      list = [];
      byFile.set(file, list);
    }
    list.push(ac);
  }

  let filesModified = 0;
  let annotationsWritten = 0;

  for (const [relativeFile, constructs] of byFile) {
    const filePath = join(corpusDir, relativeFile);
    const ext = extname(filePath);
    const prefix = commentPrefix(ext);

    const content = await readFile(filePath, 'utf-8');
    let lines = content.split('\n');

    // Sort by lineStart descending so insertions don't shift earlier positions
    const sorted = [...constructs].sort(
      (a, b) => b.construct.lineStart - a.construct.lineStart,
    );

    for (const ac of sorted) {
      // Find the @construct marker line (1-based lineStart -> 0-based index)
      const constructMarker = '@construct';
      let markerIdx = -1;

      // Search near the expected line first, then expand
      const expectedIdx = ac.construct.lineStart - 1;
      const searchRange = 5;
      const searchStart = Math.max(0, expectedIdx - searchRange);
      const searchEnd = Math.min(lines.length, expectedIdx + searchRange + 1);

      for (let i = searchStart; i < searchEnd; i++) {
        if (lines[i].includes(constructMarker)) {
          markerIdx = i;
          break;
        }
      }

      if (markerIdx === -1) {
        // Fallback: search entire file
        for (let i = 0; i < lines.length; i++) {
          if (
            lines[i].includes(constructMarker) &&
            lines[i].includes(ac.construct.id)
          ) {
            markerIdx = i;
            break;
          }
        }
      }

      if (markerIdx === -1) {
        process.stderr.write(
          `[writeback] Warning: @construct marker not found for ${ac.construct.id} in ${relativeFile}\n`,
        );
        continue;
      }

      // Remove any existing annotation block
      lines = removeExistingAnnotation(lines, markerIdx, prefix);

      // Build and insert annotation block after the @construct line
      const annotationLines = buildAnnotationBlock(ac, prefix);
      lines.splice(markerIdx + 1, 0, ...annotationLines);
      annotationsWritten++;
    }

    await writeFile(filePath, lines.join('\n'), 'utf-8');
    filesModified++;
  }

  process.stderr.write(
    `[writeback] Modified ${filesModified} files, wrote ${annotationsWritten} annotations\n`,
  );
}
