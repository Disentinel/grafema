/**
 * Stage 08 — Classify Edges
 *
 * LLM classifies each edge type's requirement profile: what context is needed
 * to create edges of that type (AST-local, scope, sibling nodes, cross-file, type info).
 * Phase is derived deterministically from the needs.
 *
 * Input:  {corpusDir}/.pipeline/03-vocabulary.json + merged annotations
 * Output: {corpusDir}/.pipeline/05-edge-requirements.json
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { batchProcess } from '../lib/llm.js';
import { readNdjson } from '../lib/parser.js';
import type {
  AnnotatedConstruct,
  TriagedConstruct,
  VocabularyAnalysis,
  EdgeNeeds,
  EdgePhase,
  EdgeRequirement,
  EdgeRequirementsOutput,
} from '../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Extract JSON from LLM response, handling markdown fences */
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

/** Derive phase from needs deterministically */
function derivePhase(needs: EdgeNeeds): EdgePhase {
  if (needs.crossFile || needs.typeInfo) return 'post-project';
  if (needs.siblingNodes) return 'post-file';
  return 'walk';
}

/** Parse LLM response into EdgeNeeds + rationale */
function parseClassificationResponse(
  text: string,
  edgeType: string,
): { needs: EdgeNeeds; rationale: string } {
  const parsed = extractJson(text);

  if (!parsed || typeof parsed !== 'object') {
    return {
      needs: { astLocal: true, scopeStack: false, siblingNodes: false, crossFile: false, typeInfo: false },
      rationale: `PARSE_ERROR: Could not extract JSON for ${edgeType}: ${text.slice(0, 200)}`,
    };
  }

  const obj = parsed as Record<string, unknown>;
  const needs = obj.needs as Record<string, boolean> | undefined;

  return {
    needs: {
      astLocal: needs?.astLocal ?? true,
      scopeStack: needs?.scopeStack ?? false,
      siblingNodes: needs?.siblingNodes ?? false,
      crossFile: needs?.crossFile ?? false,
      typeInfo: needs?.typeInfo ?? false,
    },
    rationale: typeof obj.rationale === 'string' ? obj.rationale : '',
  };
}

/** Collect all approved edge types from vocabulary analysis */
function collectApprovedEdgeTypes(vocab: VocabularyAnalysis): string[] {
  const edgeTypes = new Set<string>();
  for (const types of Object.values(vocab.approved.edgeTypes)) {
    for (const t of types) {
      edgeTypes.add(t);
    }
  }
  return [...edgeTypes].sort();
}

/** Gather usage info for a single edge type across all annotations */
function gatherEdgeUsage(
  edgeType: string,
  annotations: AnnotatedConstruct[],
): { srcNodeTypes: Set<string>; dstNodeTypes: Set<string>; count: number; examples: string[] } {
  const srcNodeTypes = new Set<string>();
  const dstNodeTypes = new Set<string>();
  const examples: string[] = [];
  let count = 0;

  for (const ac of annotations) {
    const matchingEdges = ac.annotation.edges.filter((e) => e.type === edgeType);
    if (matchingEdges.length === 0) continue;

    count += matchingEdges.length;
    if (examples.length < 5) {
      examples.push(ac.construct.id);
    }

    // Build node ID → type map for this annotation
    const nodeTypeMap = new Map<string, string>();
    for (const node of ac.annotation.nodes) {
      nodeTypeMap.set(node.id, node.type);
    }

    for (const edge of matchingEdges) {
      const srcType = nodeTypeMap.get(edge.src);
      const dstType = nodeTypeMap.get(edge.dst);
      if (srcType) srcNodeTypes.add(srcType);
      if (dstType) dstNodeTypes.add(dstType);
    }
  }

  return { srcNodeTypes, dstNodeTypes, count, examples };
}

/** Item type for batch processing */
interface EdgeTypeItem {
  edgeType: string;
  srcNodeTypes: string[];
  dstNodeTypes: string[];
  count: number;
  examples: string[];
  exampleCode: string[];
}

/**
 * Load merged annotations from pipeline: GREEN from triaged + reannotated YELLOW/RED.
 * Falls back to triaged-only if reannotation hasn't run yet.
 */
async function loadMergedAnnotations(corpusDir: string): Promise<AnnotatedConstruct[]> {
  const triagedPath = join(corpusDir, '.pipeline', '02-triaged.ndjson');
  const triaged = await readNdjson<TriagedConstruct>(triagedPath);
  const greenAnnotations = triaged.filter((t) => t.triage.color === 'GREEN');

  let reannotated: AnnotatedConstruct[] = [];
  try {
    const reannotatedPath = join(corpusDir, '.pipeline', '04-reannotated.ndjson');
    reannotated = await readNdjson<AnnotatedConstruct>(reannotatedPath);
  } catch {
    reannotated = triaged.filter((t) => t.triage.color !== 'GREEN');
  }

  const reannotatedIds = new Set(reannotated.map((r) => r.construct.id));
  return [
    ...greenAnnotations,
    ...reannotated,
    ...triaged.filter(
      (t) => t.triage.color !== 'GREEN' && !reannotatedIds.has(t.construct.id),
    ),
  ];
}

/** Detect language from corpus directory */
async function detectLanguage(corpusDir: string): Promise<{ name: string; version: string }> {
  try {
    const pkgPath = join(corpusDir, 'package.json');
    const pkgRaw = await readFile(pkgPath, 'utf-8');
    const pkg = JSON.parse(pkgRaw);
    if (pkg.langSpec) {
      return { name: pkg.langSpec.language ?? 'unknown', version: pkg.langSpec.version ?? '' };
    }
  } catch {
    // Fallback
  }
  const dirName = corpusDir.split('/').pop() ?? '';
  if (dirName.includes('javascript') || dirName.includes('js')) {
    return { name: 'javascript', version: 'ES2025' };
  }
  return { name: 'unknown', version: '' };
}

/**
 * Classify all approved edge types by their requirement profiles.
 *
 * Reads vocabulary analysis and merged annotations, then uses the LLM to
 * classify each edge type's needs. Phase is derived deterministically.
 *
 * @param corpusDir - Path to the corpus directory
 * @param options - Classification configuration (concurrency, resume)
 * @returns Edge requirements output with all classified edge types
 */
export async function classifyEdges(
  corpusDir: string,
  options?: { concurrency?: number; resume?: boolean },
): Promise<EdgeRequirementsOutput> {
  const vocabPath = join(corpusDir, '.pipeline', '03-vocabulary.json');
  const vocabRaw = await readFile(vocabPath, 'utf-8');
  const vocab: VocabularyAnalysis = JSON.parse(vocabRaw);

  const allAnnotations = await loadMergedAnnotations(corpusDir);
  const approvedEdgeTypes = collectApprovedEdgeTypes(vocab);

  process.stderr.write(
    `[classify-edges] ${approvedEdgeTypes.length} approved edge types, ${allAnnotations.length} annotations\n`,
  );

  // Build items: one per edge type with usage data
  const items: EdgeTypeItem[] = approvedEdgeTypes.map((edgeType) => {
    const usage = gatherEdgeUsage(edgeType, allAnnotations);
    const exampleCode: string[] = [];
    for (const id of usage.examples.slice(0, 3)) {
      const ac = allAnnotations.find((a) => a.construct.id === id);
      if (ac) {
        exampleCode.push(`// ${id}\n${ac.construct.code}`);
      }
    }
    return {
      edgeType,
      srcNodeTypes: [...usage.srcNodeTypes],
      dstNodeTypes: [...usage.dstNodeTypes],
      count: usage.count,
      examples: usage.examples,
      exampleCode,
    };
  });

  const systemPromptPath = join(__dirname, '..', 'prompts', 'edge-classification.md');
  const systemPrompt = await readFile(systemPromptPath, 'utf-8');

  // NDJSON for resume support during LLM calls
  const ndjsonPath = join(corpusDir, '.pipeline', '05-edge-requirements.ndjson');

  const completedIds = new Set<string>();
  if (options?.resume) {
    try {
      const existing = await readNdjson<EdgeRequirement>(ndjsonPath);
      for (const er of existing) {
        completedIds.add(er.edgeType);
      }
      process.stderr.write(
        `[classify-edges] Resume: found ${completedIds.size} existing classifications\n`,
      );
    } catch {
      // Start fresh
    }
  }

  const results = await batchProcess<EdgeTypeItem, EdgeRequirement>({
    items,
    concurrency: options?.concurrency ?? 10,
    outputPath: ndjsonPath,
    completedIds,
    getId: (item) => item.edgeType,

    makeCall: (item) => ({
      system: systemPrompt,
      user: buildUserMessage(item),
      model: 'claude-sonnet-4-20250514',
      maxTokens: 1024,
    }),

    parseResponse: (text, item) => {
      const { needs, rationale } = parseClassificationResponse(text, item.edgeType);
      return {
        edgeType: item.edgeType,
        needs,
        phase: derivePhase(needs),
        srcNodeTypes: item.srcNodeTypes,
        dstNodeTypes: item.dstNodeTypes,
        corpusCount: item.count,
        examples: item.examples,
        rationale,
      };
    },
  });

  // Build phase distribution
  const phaseDistribution: Record<EdgePhase, string[]> = {
    walk: [],
    'post-file': [],
    'post-project': [],
  };
  for (const r of results) {
    phaseDistribution[r.phase].push(r.edgeType);
  }

  const language = await detectLanguage(corpusDir);

  const output: EdgeRequirementsOutput = {
    language: language.name,
    version: language.version,
    generatedAt: new Date().toISOString(),
    requirements: results,
    phaseDistribution,
  };

  // Write final JSON output
  const finalPath = join(corpusDir, '.pipeline', '05-edge-requirements.json');
  await writeFile(finalPath, JSON.stringify(output, null, 2) + '\n', 'utf-8');

  // Log summary
  process.stderr.write(
    `[classify-edges] Complete: ${results.length} edge types classified\n` +
      `  walk:         ${phaseDistribution.walk.length}\n` +
      `  post-file:    ${phaseDistribution['post-file'].length}\n` +
      `  post-project: ${phaseDistribution['post-project'].length}\n`,
  );

  return output;
}

/** Build user message for a single edge type classification */
function buildUserMessage(item: EdgeTypeItem): string {
  const parts = [
    `Edge type: ${item.edgeType}`,
    `Occurrences in corpus: ${item.count}`,
    '',
    `Source node types observed: ${item.srcNodeTypes.join(', ') || '(none observed)'}`,
    `Destination node types observed: ${item.dstNodeTypes.join(', ') || '(none observed)'}`,
  ];

  if (item.exampleCode.length > 0) {
    parts.push('', 'Example constructs:');
    for (const code of item.exampleCode) {
      parts.push('```', code, '```');
    }
  }

  parts.push(
    '',
    `Classify the requirements for creating ${item.edgeType} edges.`,
    'Return JSON: { "needs": { "astLocal": bool, "scopeStack": bool, "siblingNodes": bool, "crossFile": bool, "typeInfo": bool }, "rationale": "..." }',
  );

  return parts.join('\n');
}
