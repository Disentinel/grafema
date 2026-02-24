/**
 * Stage 03 — Annotate (Pass 1)
 *
 * LLM annotates each parsed construct with expected graph nodes and edges.
 * This is the unconstrained pass: the LLM can use any node/edge types it
 * finds appropriate, with the baseline vocabulary provided as reference
 * (not constraint).
 *
 * Input:  {corpusDir}/.pipeline/00-parsed.ndjson + baseline vocabulary
 * Output: {corpusDir}/.pipeline/01-annotated.ndjson
 */

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { batchProcess } from '../lib/llm.js';
import { readNdjson } from '../lib/parser.js';
import type { Construct, AnnotatedConstruct, Annotation } from '../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Extract JSON from an LLM response, handling markdown code fences.
 *
 * Returns the parsed JSON object or null if extraction fails.
 */
function extractJson(text: string): unknown | null {
  let json = text.trim();

  // Strip markdown code fences
  const fencePattern = /^```(?:json)?\n([\s\S]*?)```\s*$/;
  const match = json.match(fencePattern);
  if (match) {
    json = match[1].trim();
  }

  try {
    return JSON.parse(json);
  } catch {
    // Try to find JSON object within the text
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
 * Parse an LLM response into an Annotation.
 *
 * Validates that the parsed JSON has the required nodes and edges arrays.
 * On parse failure, returns a minimal annotation with a PARSE_ERROR rationale.
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
 * Annotate all parsed constructs with expected graph nodes and edges.
 *
 * Reads parsed constructs from the pipeline NDJSON, sends each to the LLM
 * with the baseline vocabulary as reference, and writes annotated results.
 * Supports resume via the completedIds mechanism in batchProcess.
 *
 * @param corpusDir - Path to the corpus directory
 * @param options - Annotation configuration (concurrency, resume)
 * @returns Array of annotated constructs
 */
export async function annotateCorpus(
  corpusDir: string,
  options?: { concurrency?: number; resume?: boolean },
): Promise<AnnotatedConstruct[]> {
  const parsedPath = join(corpusDir, '.pipeline', '00-parsed.ndjson');
  const outputPath = join(corpusDir, '.pipeline', '01-annotated.ndjson');
  const constructs = await readNdjson<Construct>(parsedPath);

  const systemPromptPath = join(__dirname, '..', 'prompts', 'annotation-pass1.md');
  const systemPromptText = await readFile(systemPromptPath, 'utf-8');

  const baselinePath = join(__dirname, '..', '..', 'data', 'vocabulary', 'baseline.json');
  const baselineRaw = await readFile(baselinePath, 'utf-8');
  const baseline = JSON.parse(baselineRaw);

  const systemPrompt = [
    systemPromptText,
    '',
    '## Baseline Vocabulary (reference, not constraint)',
    '',
    '### Node Types',
    (baseline.nodeTypes as string[]).join(', '),
    '',
    '### Edge Types',
    (baseline.edgeTypes as string[]).join(', '),
    '',
    '### Namespaced Node Types',
    Object.entries(baseline.namespacedNodeTypes as Record<string, string[]>)
      .map(([ns, types]) => `${ns}: ${types.join(', ')}`)
      .join('\n'),
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
        `[annotate] Resume: found ${completedIds.size} existing annotations\n`,
      );
    } catch {
      // No existing file or parse error — start fresh
    }
  }

  const results = await batchProcess<Construct, AnnotatedConstruct>({
    items: constructs,
    concurrency: options?.concurrency ?? 10,
    outputPath,
    completedIds,
    getId: (c) => c.id,

    makeCall: (construct) => ({
      system: systemPrompt,
      user: buildUserMessage(construct),
      model: 'claude-sonnet-4-20250514',
      maxTokens: 2048,
    }),

    parseResponse: (text, construct) => {
      const annotation = parseAnnotationResponse(text);
      return {
        construct,
        annotation,
        pass: 1 as const,
        annotatedAt: new Date().toISOString(),
      };
    },
  });

  // Log summary
  const errorCount = results.filter((r) =>
    r.annotation.rationale.startsWith('PARSE_ERROR:'),
  ).length;
  process.stderr.write(
    `[annotate] Pass 1 complete: ${results.length} annotated` +
      `, ${completedIds.size} resumed` +
      `, ${errorCount} parse errors\n`,
  );

  return results;
}

/**
 * Build the user message for a single construct annotation call.
 */
function buildUserMessage(construct: Construct): string {
  const parts = [
    `Construct ID: ${construct.id}`,
    `Category: ${construct.category}`,
    `Commented out: ${construct.commentedOut}`,
  ];

  if (construct.moduleType) {
    parts.push(`Module type: ${construct.moduleType}`);
  }

  parts.push(
    '',
    'Code:',
    '```',
    construct.code,
    '```',
    '',
    'Annotate this construct with the expected graph nodes and edges.',
    'Return JSON: { "nodes": [...], "edges": [...], "rationale": "...", "implicitBehavior": [...] }',
  );

  return parts.join('\n');
}
