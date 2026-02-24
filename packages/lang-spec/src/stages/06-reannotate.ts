/**
 * Stage 06 — Reannotate (Pass 2)
 *
 * Re-annotates YELLOW and RED triaged constructs with a vocabulary
 * constraint. Unlike Pass 1 (unconstrained), this pass requires the LLM
 * to use ONLY approved node/edge types from the vocabulary analysis.
 *
 * Input:  {corpusDir}/.pipeline/02-triaged.ndjson + {corpusDir}/.pipeline/03-vocabulary.json
 * Output: {corpusDir}/.pipeline/04-reannotated.ndjson
 */

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { batchProcess } from '../lib/llm.js';
import { readNdjson } from '../lib/parser.js';
import type {
  TriagedConstruct,
  AnnotatedConstruct,
  Annotation,
  VocabularyAnalysis,
} from '../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Extract JSON from an LLM response, handling markdown code fences.
 */
function extractJson(text: string): unknown | null {
  let json = text.trim();

  const fencePattern = /^```(?:json)?\n([\s\S]*?)```\s*$/;
  const match = json.match(fencePattern);
  if (match) {
    json = match[1].trim();
  }

  try {
    return JSON.parse(json);
  } catch {
    const objMatch = json.match(/\{[\s\S]*\}/);
    if (objMatch) {
      try {
        return JSON.parse(objMatch[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * Parse an LLM response into an Annotation for Pass 2.
 *
 * Same structure as Pass 1 but expected to conform to the approved vocabulary.
 */
function parseAnnotationResponse(text: string): Annotation {
  const parsed = extractJson(text);

  if (parsed === null) {
    return {
      nodes: [],
      edges: [],
      rationale: `PARSE_ERROR: Could not extract JSON from response: ${text.slice(0, 200)}`,
    };
  }

  const obj = parsed as Record<string, unknown>;

  if (!Array.isArray(obj.nodes) || !Array.isArray(obj.edges)) {
    return {
      nodes: [],
      edges: [],
      rationale: `PARSE_ERROR: Response missing nodes or edges array: ${JSON.stringify(obj).slice(0, 200)}`,
    };
  }

  return {
    nodes: obj.nodes,
    edges: obj.edges,
    rationale: typeof obj.rationale === 'string' ? obj.rationale : '',
    implicitBehavior: Array.isArray(obj.implicitBehavior)
      ? obj.implicitBehavior.filter((v: unknown) => typeof v === 'string')
      : undefined,
  };
}

/**
 * Build a flat list of all approved node and edge types from the vocabulary analysis.
 */
function buildApprovedTypeList(vocab: VocabularyAnalysis): {
  nodeTypes: string[];
  edgeTypes: string[];
} {
  const nodeTypes: string[] = [];
  for (const types of Object.values(vocab.approved.nodeTypes)) {
    nodeTypes.push(...types);
  }

  const edgeTypes: string[] = [];
  for (const types of Object.values(vocab.approved.edgeTypes)) {
    edgeTypes.push(...types);
  }

  return { nodeTypes, edgeTypes };
}

/**
 * Re-annotate YELLOW and RED constructs with vocabulary constraint.
 *
 * Reads triaged constructs from the pipeline, filters to only YELLOW and
 * RED entries, then sends each to the LLM with a hard constraint: only
 * approved vocabulary types may be used. Supports resume.
 *
 * @param corpusDir - Path to the corpus directory
 * @param options - Reannotation configuration (concurrency, resume)
 * @returns Array of reannotated constructs
 */
export async function reannotateCorpus(
  corpusDir: string,
  options?: { concurrency?: number; resume?: boolean },
): Promise<AnnotatedConstruct[]> {
  const triagedPath = join(corpusDir, '.pipeline', '02-triaged.ndjson');
  const vocabPath = join(corpusDir, '.pipeline', '03-vocabulary.json');
  const outputPath = join(corpusDir, '.pipeline', '04-reannotated.ndjson');

  const allTriaged = await readNdjson<TriagedConstruct>(triagedPath);
  const needsReannotation = allTriaged.filter(
    (tc) => tc.triage.color === 'YELLOW' || tc.triage.color === 'RED',
  );

  process.stderr.write(
    `[reannotate] ${needsReannotation.length} constructs need re-annotation` +
      ` (${allTriaged.length - needsReannotation.length} GREEN skipped)\n`,
  );

  if (needsReannotation.length === 0) {
    process.stderr.write('[reannotate] Nothing to reannotate\n');
    return [];
  }

  // Load approved vocabulary
  const vocabRaw = await readFile(vocabPath, 'utf-8');
  const vocab: VocabularyAnalysis = JSON.parse(vocabRaw);
  const approved = buildApprovedTypeList(vocab);

  // Load system prompt
  const systemPromptPath = join(__dirname, '..', 'prompts', 'annotation-pass2.md');
  const systemPromptText = await readFile(systemPromptPath, 'utf-8');

  const systemPrompt = [
    systemPromptText,
    '',
    '## HARD CONSTRAINT: Approved Vocabulary',
    '',
    'You MUST use ONLY these node/edge types. If no type fits, use the closest',
    'match and explain in a "gaps" array in your response.',
    '',
    '### Approved Node Types',
    approved.nodeTypes.join(', '),
    '',
    '### Approved Edge Types',
    approved.edgeTypes.join(', '),
  ].join('\n');

  // Determine completed IDs for resume
  const completedIds = new Set<string>();
  if (options?.resume) {
    try {
      const existing = await readNdjson<AnnotatedConstruct>(outputPath);
      for (const ac of existing) {
        completedIds.add(ac.construct.id);
      }
      process.stderr.write(
        `[reannotate] Resume: found ${completedIds.size} existing reannotations\n`,
      );
    } catch {
      // No existing file or parse error — start fresh
    }
  }

  const results = await batchProcess<TriagedConstruct, AnnotatedConstruct>({
    items: needsReannotation,
    concurrency: options?.concurrency ?? 10,
    outputPath,
    completedIds,
    getId: (tc) => tc.construct.id,

    makeCall: (tc) => ({
      system: systemPrompt,
      user: buildUserMessage(tc),
      model: 'claude-sonnet-4-20250514',
      maxTokens: 2048,
    }),

    parseResponse: (text, tc) => {
      const annotation = parseAnnotationResponse(text);
      return {
        construct: tc.construct,
        annotation,
        pass: 2 as const,
        annotatedAt: new Date().toISOString(),
      };
    },
  });

  // Log summary
  const errorCount = results.filter((r) =>
    r.annotation.rationale.startsWith('PARSE_ERROR:'),
  ).length;
  process.stderr.write(
    `[reannotate] Pass 2 complete: ${results.length} reannotated` +
      `, ${completedIds.size} resumed` +
      `, ${errorCount} parse errors\n`,
  );

  return results;
}

/**
 * Build the user message for a single construct reannotation call.
 */
function buildUserMessage(tc: TriagedConstruct): string {
  const parts = [
    `Construct ID: ${tc.construct.id}`,
    `Category: ${tc.construct.category}`,
    `Commented out: ${tc.construct.commentedOut}`,
  ];

  if (tc.construct.moduleType) {
    parts.push(`Module type: ${tc.construct.moduleType}`);
  }

  parts.push(
    '',
    'Code:',
    '```',
    tc.construct.code,
    '```',
    '',
    `Triage: ${tc.triage.color} — ${tc.triage.reason}`,
    '',
    'Pass 1 annotation (for comparison):',
    '```json',
    JSON.stringify(tc.annotation, null, 2),
    '```',
    '',
    'Re-annotate this construct using ONLY the approved vocabulary types.',
    'Return JSON: { "nodes": [...], "edges": [...], "rationale": "...", "implicitBehavior": [...] }',
    'If no approved type fits a needed concept, use the closest match and add a "gaps" array explaining what is missing.',
  );

  return parts.join('\n');
}
