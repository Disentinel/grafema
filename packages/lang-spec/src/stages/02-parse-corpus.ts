/**
 * Stage 02 — Parse Corpus
 *
 * Extracts @construct blocks from corpus source files into NDJSON format.
 * This is a deterministic stage (no LLM). Reads all source files in the
 * corpus directory, parses @construct markers, and writes structured
 * records to .pipeline/00-parsed.ndjson.
 *
 * Input:  corpus directory with source files containing @construct markers
 * Output: {corpusDir}/.pipeline/00-parsed.ndjson
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseCorpusDir, writeNdjson } from '../lib/parser.js';
import type { Construct } from '../types.js';

/**
 * Parse all @construct blocks from corpus source files to NDJSON.
 *
 * Scans all source files in corpusDir, extracts @construct-delimited
 * code blocks, and writes them as structured Construct records.
 *
 * @param corpusDir - Path to the corpus directory containing source files
 * @returns Array of parsed Construct records
 */
export async function parseCorpus(corpusDir: string): Promise<Construct[]> {
  const constructs = await parseCorpusDir(corpusDir);

  const pipelineDir = join(corpusDir, '.pipeline');
  await mkdir(pipelineDir, { recursive: true });

  const outputPath = join(pipelineDir, '00-parsed.ndjson');
  await writeNdjson(constructs, outputPath);

  const fileCount = new Set(constructs.map((c) => c.file)).size;
  process.stderr.write(
    `[parse] Parsed ${constructs.length} constructs from ${fileCount} files\n`,
  );

  return constructs;
}
