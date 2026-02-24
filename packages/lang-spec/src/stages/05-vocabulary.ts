/**
 * Stage 05 — Vocabulary Extraction
 *
 * Extracts all node/edge types from annotations, clusters synonyms,
 * and diffs against the baseline vocabulary. Deterministic stage (no LLM).
 *
 * Produces a human-editable vocabulary analysis checkpoint that
 * distinguishes approved types, new discoveries, synonym clusters,
 * unused baseline types, plugin territory, and spurious noise.
 *
 * Input:  {corpusDir}/.pipeline/02-triaged.ndjson
 * Output: {corpusDir}/.pipeline/03-vocabulary.json
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readNdjson } from '../lib/parser.js';
import { diffAgainstBaseline } from '../lib/vocabulary-ops.js';
import type {
  BaselineVocabulary,
  TriagedConstruct,
  VocabularyAnalysis,
} from '../types.js';

/**
 * Extract vocabulary from annotations, cluster synonyms, diff against baseline.
 *
 * Reads triaged constructs, collects all unique node and edge types
 * with occurrence counts and example construct IDs, then runs the
 * baseline diff to produce a full VocabularyAnalysis.
 *
 * @param corpusDir - Path to the corpus directory
 * @returns The vocabulary analysis result
 */
export async function extractVocabulary(
  corpusDir: string,
): Promise<VocabularyAnalysis> {
  const triaged = await readNdjson<TriagedConstruct>(
    join(corpusDir, '.pipeline', '02-triaged.ndjson'),
  );

  // Collect type counts and examples
  const typeCounts = new Map<string, number>();
  const typeExamples = new Map<string, string[]>();

  for (const tc of triaged) {
    const constructId = tc.construct.id;

    for (const node of tc.annotation.nodes) {
      const t = node.type;
      typeCounts.set(t, (typeCounts.get(t) ?? 0) + 1);
      addExample(typeExamples, t, constructId);
    }

    for (const edge of tc.annotation.edges) {
      const t = edge.type;
      typeCounts.set(t, (typeCounts.get(t) ?? 0) + 1);
      addExample(typeExamples, t, constructId);
    }
  }

  // Load baseline
  const baselinePath = fileURLToPath(
    new URL('../../data/vocabulary/baseline.json', import.meta.url),
  );
  const raw = await readFile(baselinePath, 'utf-8');
  const baseline: BaselineVocabulary = JSON.parse(raw);

  // Run diff
  const analysis = diffAgainstBaseline(typeCounts, baseline);

  // Enrich `new` entries with examples
  for (const entry of analysis.new) {
    entry.examples = typeExamples.get(entry.type)?.slice(0, 3) ?? [];
  }

  // Write pretty-printed JSON for human editing
  const outputPath = join(corpusDir, '.pipeline', '03-vocabulary.json');
  await writeFile(outputPath, JSON.stringify(analysis, null, 2) + '\n', 'utf-8');

  // Log summary
  const nodeTypeCount = new Set(
    triaged.flatMap((tc) => tc.annotation.nodes.map((n) => n.type)),
  ).size;
  const edgeTypeCount = new Set(
    triaged.flatMap((tc) => tc.annotation.edges.map((e) => e.type)),
  ).size;
  const newWith3Plus = analysis.new.filter((n) => n.count >= 3).length;

  process.stderr.write(
    `[vocabulary] Summary:\n` +
      `  Total unique node types: ${nodeTypeCount}\n` +
      `  Total unique edge types: ${edgeTypeCount}\n` +
      `  New types (3+ occurrences): ${newWith3Plus}\n` +
      `  Spurious (1-2 occurrences): ${analysis.spurious.length}\n` +
      `  Unused baseline types: ${analysis.unused.length}\n` +
      `  Synonym clusters found: ${analysis.synonymClusters.length}\n`,
  );

  return analysis;
}

/**
 * Add a construct ID as an example for a type, capped at 3 examples.
 */
function addExample(
  examples: Map<string, string[]>,
  type: string,
  constructId: string,
): void {
  let list = examples.get(type);
  if (!list) {
    list = [];
    examples.set(type, list);
  }
  if (list.length < 3 && !list.includes(constructId)) {
    list.push(constructId);
  }
}
