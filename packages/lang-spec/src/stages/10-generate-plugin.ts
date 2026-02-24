/**
 * Stage 10 — Generate Plugin
 *
 * Generates Grafema plugin scaffolds from the rule table, edge requirements,
 * and test suite. Produces:
 * - rule-table.json (deterministic grouping + LLM disambiguation)
 * - {lang}-analyzer.ts (ANALYSIS plugin for walk-phase)
 * - {lang}-post-file-enricher.ts (ENRICHMENT plugin for post-file)
 * - {lang}-post-project-enricher.ts (ENRICHMENT plugin for post-project)
 * - tests/{lang}-analyzer.test.ts
 * - tests/{lang}-enrichers.test.ts
 *
 * Input:  vocabulary + edge requirements + test suite
 * Output: {corpusDir}/.pipeline/07-plugins/ directory
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { batchProcess } from '../lib/llm.js';
import { readNdjson } from '../lib/parser.js';
import {
  generateAnalysisPlugin,
  generateEnrichmentPlugin,
  generateWalkTests,
  generateEnrichmentTests,
} from '../lib/codegen.js';
import type {
  AnnotatedConstruct,
  TriagedConstruct,
  EdgeRequirementsOutput,
  TestSuiteOutput,
  Rule,
  RuleCondition,
  RuleTable,
  PluginScaffoldOutput,
  GeneratedPluginFile,
} from '../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Extract JSON from LLM response */
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
    const arrMatch = json.match(/\[[\s\S]*\]/);
    if (arrMatch) {
      try {
        return JSON.parse(arrMatch[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

/** Group constructs by the primary AST node type their code implies */
interface ConstructGroup {
  astNodeType: string;
  constructs: Array<{
    id: string;
    code: string;
    nodeTypes: string[];
    edgeTypes: string[];
  }>;
}

/**
 * Infer AST node type from construct code.
 * Simple heuristic based on code patterns — not a full parser.
 */
function inferAstNodeType(code: string): string {
  const trimmed = code.trim();

  if (/^(export\s+)?(async\s+)?function\s/.test(trimmed)) return 'FunctionDeclaration';
  if (/^(export\s+)?class\s/.test(trimmed)) return 'ClassDeclaration';
  if (/^(export\s+)?(const|let|var)\s/.test(trimmed)) return 'VariableDeclaration';
  if (/^(export\s+)?default\s/.test(trimmed)) return 'ExportDefaultDeclaration';
  if (/^export\s*\{/.test(trimmed)) return 'ExportNamedDeclaration';
  if (/^import\s/.test(trimmed)) return 'ImportDeclaration';
  if (/^if\s*\(/.test(trimmed)) return 'IfStatement';
  if (/^(for|while|do)\s*[\({]/.test(trimmed)) return 'LoopStatement';
  if (/^switch\s*\(/.test(trimmed)) return 'SwitchStatement';
  if (/^try\s*\{/.test(trimmed)) return 'TryStatement';
  if (/^throw\s/.test(trimmed)) return 'ThrowStatement';
  if (/^return\s/.test(trimmed)) return 'ReturnStatement';
  if (/^yield\s/.test(trimmed)) return 'YieldExpression';
  if (/^await\s/.test(trimmed)) return 'AwaitExpression';
  if (/^\w+\s*\(/.test(trimmed)) return 'CallExpression';
  if (/^\w+\.\w+\s*=/.test(trimmed)) return 'AssignmentExpression';
  if (/^\w+\s*=/.test(trimmed)) return 'AssignmentExpression';

  return 'Unknown';
}

/** Group constructs by inferred AST node type */
function groupByAstType(annotations: AnnotatedConstruct[]): ConstructGroup[] {
  const groups = new Map<string, ConstructGroup>();

  for (const ac of annotations) {
    const astType = inferAstNodeType(ac.construct.code);
    let group = groups.get(astType);
    if (!group) {
      group = { astNodeType: astType, constructs: [] };
      groups.set(astType, group);
    }
    group.constructs.push({
      id: ac.construct.id,
      code: ac.construct.code,
      nodeTypes: ac.annotation.nodes.map((n) => n.type),
      edgeTypes: ac.annotation.edges.map((e) => e.type),
    });
  }

  return [...groups.values()].sort((a, b) => a.astNodeType.localeCompare(b.astNodeType));
}

/** Check if a group has ambiguous patterns (same AST type → different graph outputs) */
function isAmbiguous(group: ConstructGroup): boolean {
  if (group.constructs.length <= 1) return false;

  const signatures = new Set<string>();
  for (const c of group.constructs) {
    const sig = [...new Set(c.nodeTypes)].sort().join(',') + '|' + [...new Set(c.edgeTypes)].sort().join(',');
    signatures.add(sig);
  }

  return signatures.size > 1;
}

/** Build a deterministic rule from a non-ambiguous construct group */
function buildSimpleRule(group: ConstructGroup): Rule {
  const allNodeTypes = new Set<string>();
  const allEdgeTypes = new Set<string>();
  const derivedFrom: string[] = [];

  for (const c of group.constructs) {
    for (const nt of c.nodeTypes) allNodeTypes.add(nt);
    for (const et of c.edgeTypes) allEdgeTypes.add(et);
    derivedFrom.push(c.id);
  }

  return {
    astNodeType: group.astNodeType,
    conditions: [],
    emitNodes: [...allNodeTypes].map((type) => ({
      type,
      idTemplate: '$name',
      metadataMap: {},
    })),
    emitEdges: [...allEdgeTypes].map((type) => ({
      type,
      srcRef: '$self',
      dstRef: '$child',
      phase: 'walk' as const,
    })),
    derivedFrom,
  };
}

/** Ambiguous group item for LLM batch processing */
interface AmbiguousGroupItem {
  group: ConstructGroup;
  subGroups: Array<{
    signature: string;
    constructs: ConstructGroup['constructs'];
  }>;
}

/**
 * Load merged annotations from pipeline.
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

/**
 * Generate plugin scaffolds from the analysis pipeline outputs.
 *
 * Sub-steps:
 * 10a: Rule table compilation (deterministic + LLM for ambiguous groups)
 * 10b: Analysis plugin generation
 * 10c: Enrichment plugin generation
 * 10d: Test file generation
 *
 * @param corpusDir - Path to the corpus directory
 * @param options - Generation configuration (concurrency)
 * @returns Plugin scaffold output metadata
 */
export async function generatePlugin(
  corpusDir: string,
  options?: { concurrency?: number },
): Promise<PluginScaffoldOutput> {
  const outputDir = join(corpusDir, '.pipeline', '07-plugins');
  const testsDir = join(outputDir, 'tests');
  await mkdir(outputDir, { recursive: true });
  await mkdir(testsDir, { recursive: true });

  // Load inputs
  const reqPath = join(corpusDir, '.pipeline', '05-edge-requirements.json');
  const reqRaw = await readFile(reqPath, 'utf-8');
  const requirements: EdgeRequirementsOutput = JSON.parse(reqRaw);

  const testSuitePath = join(corpusDir, '.pipeline', '06-test-suite.json');
  const testSuiteRaw = await readFile(testSuitePath, 'utf-8');
  const testSuite: TestSuiteOutput = JSON.parse(testSuiteRaw);

  const allAnnotations = await loadMergedAnnotations(corpusDir);
  const validAnnotations = allAnnotations.filter(
    (ac) => !ac.annotation.rationale.startsWith('PARSE_ERROR:'),
  );

  const language = requirements.language;

  process.stderr.write(
    `[generate-plugin] Language: ${language}, ${validAnnotations.length} annotations\n`,
  );

  // === 10a: Rule Table Compilation ===
  const groups = groupByAstType(validAnnotations);
  const rules: Rule[] = [];

  const simpleGroups: ConstructGroup[] = [];
  const ambiguousItems: AmbiguousGroupItem[] = [];

  for (const group of groups) {
    if (group.astNodeType === 'Unknown') continue;

    if (isAmbiguous(group)) {
      // Split into sub-groups by output signature
      const subGroupMap = new Map<string, ConstructGroup['constructs']>();
      for (const c of group.constructs) {
        const sig = [...new Set(c.nodeTypes)].sort().join(',') + '|' + [...new Set(c.edgeTypes)].sort().join(',');
        let arr = subGroupMap.get(sig);
        if (!arr) {
          arr = [];
          subGroupMap.set(sig, arr);
        }
        arr.push(c);
      }
      ambiguousItems.push({
        group,
        subGroups: [...subGroupMap.entries()].map(([signature, constructs]) => ({
          signature,
          constructs,
        })),
      });
    } else {
      simpleGroups.push(group);
    }
  }

  // Add simple rules
  for (const group of simpleGroups) {
    rules.push(buildSimpleRule(group));
  }

  process.stderr.write(
    `[generate-plugin] ${simpleGroups.length} simple groups, ${ambiguousItems.length} ambiguous groups\n`,
  );

  // LLM disambiguation for ambiguous groups
  if (ambiguousItems.length > 0) {
    const systemPromptPath = join(__dirname, '..', 'prompts', 'plugin-generation.md');
    const systemPrompt = await readFile(systemPromptPath, 'utf-8');

    const disambiguated = await batchProcess<AmbiguousGroupItem, Rule[]>({
      items: ambiguousItems,
      concurrency: options?.concurrency ?? 10,
      getId: (item) => item.group.astNodeType,

      makeCall: (item) => ({
        system: systemPrompt,
        user: buildDisambiguationMessage(item),
        model: 'claude-sonnet-4-20250514',
        maxTokens: 2048,
      }),

      parseResponse: (text, item) => {
        return parseDisambiguationResponse(text, item);
      },
    });

    for (const ruleSet of disambiguated) {
      rules.push(...ruleSet);
    }
  }

  const ruleTable: RuleTable = {
    language,
    version: requirements.version,
    generatedAt: new Date().toISOString(),
    rules,
  };

  await writeFile(
    join(outputDir, 'rule-table.json'),
    JSON.stringify(ruleTable, null, 2) + '\n',
    'utf-8',
  );

  process.stderr.write(`[generate-plugin] Rule table: ${rules.length} rules\n`);

  // === 10b: Analysis Plugin ===
  const walkEdgeTypes = requirements.phaseDistribution.walk;
  const walkNodeTypes = collectWalkNodeTypes(validAnnotations);

  const walkRules = rules.filter((r) =>
    r.emitEdges.some((e) => e.phase === 'walk') || r.emitEdges.length === 0,
  );

  const analyzerResult = generateAnalysisPlugin(language, walkRules, walkEdgeTypes, walkNodeTypes);
  await writeFile(join(outputDir, analyzerResult.pluginFile.path), analyzerResult.code, 'utf-8');
  const plugins: GeneratedPluginFile[] = [analyzerResult.pluginFile];

  // === 10c: Enrichment Plugins ===
  const postFileEdgeTypes = requirements.phaseDistribution['post-file'];
  const postProjectEdgeTypes = requirements.phaseDistribution['post-project'];

  if (postFileEdgeTypes.length > 0) {
    const consumedNodeTypes = collectConsumedNodeTypes(requirements, 'post-file');
    const postFileResult = generateEnrichmentPlugin(language, 'post-file', postFileEdgeTypes, consumedNodeTypes);
    await writeFile(join(outputDir, postFileResult.pluginFile.path), postFileResult.code, 'utf-8');
    plugins.push(postFileResult.pluginFile);
  }

  if (postProjectEdgeTypes.length > 0) {
    const consumedNodeTypes = collectConsumedNodeTypes(requirements, 'post-project');
    const postProjectResult = generateEnrichmentPlugin(language, 'post-project', postProjectEdgeTypes, consumedNodeTypes);
    await writeFile(join(outputDir, postProjectResult.pluginFile.path), postProjectResult.code, 'utf-8');
    plugins.push(postProjectResult.pluginFile);
  }

  // === 10d: Test Files ===
  let testFileCount = 0;

  const walkTestCode = generateWalkTests(language, testSuite.cases);
  await writeFile(join(testsDir, `${language}-analyzer.test.ts`), walkTestCode, 'utf-8');
  testFileCount++;

  const enrichmentTestCode = generateEnrichmentTests(language, testSuite.cases);
  await writeFile(join(testsDir, `${language}-enrichers.test.ts`), enrichmentTestCode, 'utf-8');
  testFileCount++;

  const output: PluginScaffoldOutput = {
    language,
    version: requirements.version,
    generatedAt: new Date().toISOString(),
    plugins,
    ruleTable,
    testFileCount,
  };

  // Write scaffold metadata
  await writeFile(
    join(outputDir, 'scaffold-output.json'),
    JSON.stringify(output, null, 2) + '\n',
    'utf-8',
  );

  process.stderr.write(
    `[generate-plugin] Complete:\n` +
      `  Plugins: ${plugins.length} (${plugins.map((p) => p.className).join(', ')})\n` +
      `  Rules: ${rules.length}\n` +
      `  Test files: ${testFileCount}\n`,
  );

  return output;
}

/** Collect all node types that appear in walk-phase annotations */
function collectWalkNodeTypes(annotations: AnnotatedConstruct[]): string[] {
  const types = new Set<string>();
  for (const ac of annotations) {
    for (const node of ac.annotation.nodes) {
      types.add(node.type);
    }
  }
  return [...types].sort();
}

/** Collect node types consumed by a specific enrichment phase */
function collectConsumedNodeTypes(
  requirements: EdgeRequirementsOutput,
  phase: 'post-file' | 'post-project',
): string[] {
  const types = new Set<string>();
  for (const req of requirements.requirements) {
    if (req.phase === phase) {
      for (const t of req.srcNodeTypes) types.add(t);
      for (const t of req.dstNodeTypes) types.add(t);
    }
  }
  return [...types].sort();
}

/** Build disambiguation message for an ambiguous AST node type group */
function buildDisambiguationMessage(item: AmbiguousGroupItem): string {
  const parts = [
    `AST node type: ${item.group.astNodeType}`,
    `Total constructs: ${item.group.constructs.length}`,
    `Distinct output patterns: ${item.subGroups.length}`,
    '',
  ];

  for (let i = 0; i < item.subGroups.length; i++) {
    const sg = item.subGroups[i];
    parts.push(`--- Pattern ${i} ---`);
    parts.push(`Node types: ${[...new Set(sg.constructs.flatMap((c) => c.nodeTypes))].join(', ')}`);
    parts.push(`Edge types: ${[...new Set(sg.constructs.flatMap((c) => c.edgeTypes))].join(', ')}`);
    parts.push('Examples:');
    for (const c of sg.constructs.slice(0, 2)) {
      parts.push('```', c.code, '```');
    }
    parts.push('');
  }

  parts.push(
    'Generate disambiguating conditions for each pattern.',
    'Return JSON array: [{ "groupIndex": 0, "conditions": [...] }, ...]',
  );

  return parts.join('\n');
}

/** Parse LLM disambiguation response into rules */
function parseDisambiguationResponse(
  text: string,
  item: AmbiguousGroupItem,
): Rule[] {
  const parsed = extractJson(text);
  const rules: Rule[] = [];

  if (Array.isArray(parsed)) {
    for (const entry of parsed) {
      const obj = entry as Record<string, unknown>;
      const groupIndex = typeof obj.groupIndex === 'number' ? obj.groupIndex : -1;
      const conditions = Array.isArray(obj.conditions)
        ? (obj.conditions as RuleCondition[])
        : [];

      const sg = item.subGroups[groupIndex];
      if (!sg) continue;

      const allNodeTypes = new Set<string>();
      const allEdgeTypes = new Set<string>();
      const derivedFrom: string[] = [];

      for (const c of sg.constructs) {
        for (const nt of c.nodeTypes) allNodeTypes.add(nt);
        for (const et of c.edgeTypes) allEdgeTypes.add(et);
        derivedFrom.push(c.id);
      }

      rules.push({
        astNodeType: item.group.astNodeType,
        conditions,
        emitNodes: [...allNodeTypes].map((type) => ({
          type,
          idTemplate: '$name',
          metadataMap: {},
        })),
        emitEdges: [...allEdgeTypes].map((type) => ({
          type,
          srcRef: '$self',
          dstRef: '$child',
          phase: 'walk' as const,
        })),
        derivedFrom,
      });
    }
  }

  // Fallback: if parsing failed, create one rule per subgroup with no conditions
  if (rules.length === 0) {
    for (const sg of item.subGroups) {
      const allNodeTypes = new Set<string>();
      const allEdgeTypes = new Set<string>();
      const derivedFrom: string[] = [];

      for (const c of sg.constructs) {
        for (const nt of c.nodeTypes) allNodeTypes.add(nt);
        for (const et of c.edgeTypes) allEdgeTypes.add(et);
        derivedFrom.push(c.id);
      }

      rules.push({
        astNodeType: item.group.astNodeType,
        conditions: [],
        emitNodes: [...allNodeTypes].map((type) => ({
          type,
          idTemplate: '$name',
          metadataMap: {},
        })),
        emitEdges: [...allEdgeTypes].map((type) => ({
          type,
          srcRef: '$self',
          dstRef: '$child',
          phase: 'walk' as const,
        })),
        derivedFrom,
      });
    }
  }

  return rules;
}
