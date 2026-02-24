/**
 * Stage 04 — Triage
 *
 * Auto-classifies annotated constructs into GREEN / YELLOW / RED
 * based on objective, deterministic signals. No LLM involved.
 *
 * Classification criteria:
 *   GREEN  — edges <= 3, no implicitBehavior, 0 new types
 *   YELLOW — edges 4-6, or implicitBehavior present, or 1 new type
 *   RED    — edges 7+, or 2+ new types, or parse error in annotation
 *
 * Input:  {corpusDir}/.pipeline/01-annotated.ndjson
 * Output: {corpusDir}/.pipeline/02-triaged.ndjson
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readNdjson, writeNdjson } from '../lib/parser.js';
import type {
  AnnotatedConstruct,
  BaselineVocabulary,
  TriageColor,
  TriagedConstruct,
} from '../types.js';

/**
 * Classify a single annotated construct by objective signals.
 *
 * Checks edge count, presence of implicit behavior, and whether
 * annotation types exist in the baseline vocabulary.
 */
function classifyConstruct(
  ac: AnnotatedConstruct,
  baselineTypes: Set<string>,
): { color: TriageColor; reason: string } {
  const edgeCount = ac.annotation.edges.length;
  const hasImplicit =
    Array.isArray(ac.annotation.implicitBehavior) &&
    ac.annotation.implicitBehavior.length > 0;

  // Count types not present in baseline
  const allTypes = new Set<string>();
  for (const node of ac.annotation.nodes) {
    allTypes.add(node.type);
  }
  for (const edge of ac.annotation.edges) {
    allTypes.add(edge.type);
  }

  let newTypeCount = 0;
  for (const t of allTypes) {
    if (!baselineTypes.has(t)) {
      newTypeCount++;
    }
  }

  // RED: edges 7+ OR 2+ new types
  if (edgeCount >= 7) {
    return {
      color: 'RED',
      reason: `${edgeCount} edges (threshold: 7)`,
    };
  }
  if (newTypeCount >= 2) {
    return {
      color: 'RED',
      reason: `${newTypeCount} new types not in baseline (threshold: 2)`,
    };
  }

  // YELLOW: edges 4-6 OR implicitBehavior OR 1 new type
  const yellowReasons: string[] = [];
  if (edgeCount >= 4) {
    yellowReasons.push(`${edgeCount} edges`);
  }
  if (hasImplicit) {
    yellowReasons.push(
      `implicitBehavior: ${ac.annotation.implicitBehavior!.join(', ')}`,
    );
  }
  if (newTypeCount === 1) {
    yellowReasons.push('1 new type not in baseline');
  }

  if (yellowReasons.length > 0) {
    return { color: 'YELLOW', reason: yellowReasons.join('; ') };
  }

  // GREEN: edges <= 3, no implicitBehavior, 0 new types
  return { color: 'GREEN', reason: 'simple construct, all types in baseline' };
}

/**
 * Load the baseline vocabulary and build a flat set of all known types.
 */
async function loadBaselineTypes(): Promise<Set<string>> {
  const baselinePath = fileURLToPath(
    new URL('../../data/vocabulary/baseline.json', import.meta.url),
  );
  const raw = await readFile(baselinePath, 'utf-8');
  const baseline: BaselineVocabulary = JSON.parse(raw);

  const types = new Set<string>();
  for (const t of baseline.nodeTypes) {
    types.add(t);
  }
  for (const t of baseline.edgeTypes) {
    types.add(t);
  }
  for (const ns of Object.values(baseline.namespacedNodeTypes)) {
    for (const t of ns) {
      types.add(t);
    }
  }
  return types;
}

/**
 * Auto-classify all annotated constructs into GREEN / YELLOW / RED.
 *
 * Reads the annotated NDJSON from the pipeline directory, applies
 * deterministic classification rules, and writes triaged output.
 *
 * @param corpusDir - Path to the corpus directory
 * @returns Array of triaged constructs with color and reason
 */
export async function triageAnnotations(
  corpusDir: string,
): Promise<TriagedConstruct[]> {
  const annotated = await readNdjson<AnnotatedConstruct>(
    `${corpusDir}/.pipeline/01-annotated.ndjson`,
  );
  const baselineTypes = await loadBaselineTypes();

  const triaged: TriagedConstruct[] = annotated.map((ac) => {
    const { color, reason } = classifyConstruct(ac, baselineTypes);
    return { ...ac, triage: { color, reason } };
  });

  await writeNdjson(triaged, `${corpusDir}/.pipeline/02-triaged.ndjson`);

  // Log distribution
  const counts: Record<TriageColor, number> = { GREEN: 0, YELLOW: 0, RED: 0 };
  for (const t of triaged) {
    counts[t.triage.color]++;
  }
  const total = triaged.length;
  const pct = (n: number): string =>
    total > 0 ? ((n / total) * 100).toFixed(1) : '0.0';

  process.stderr.write(
    `[triage] Distribution (${total} constructs):\n` +
      `  GREEN:  ${counts.GREEN} (${pct(counts.GREEN)}%)\n` +
      `  YELLOW: ${counts.YELLOW} (${pct(counts.YELLOW)}%)\n` +
      `  RED:    ${counts.RED} (${pct(counts.RED)}%)\n`,
  );

  return triaged;
}
