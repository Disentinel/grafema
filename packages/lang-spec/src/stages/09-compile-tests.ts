/**
 * Stage 09 — Compile Tests
 *
 * Deterministic stage: converts merged annotations + edge phase map into
 * structured test cases. Each annotated construct becomes a TestCase with
 * expectedNodes and expectedEdges bucketed by phase (walk/postFile/postProject).
 *
 * Input:  merged annotations + {corpusDir}/.pipeline/05-edge-requirements.json
 * Output: {corpusDir}/.pipeline/06-test-suite.json
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readNdjson } from '../lib/parser.js';
import type {
  AnnotatedConstruct,
  TriagedConstruct,
  EdgeRequirementsOutput,
  EdgePhase,
  TestCase,
  TestExpectedNode,
  TestExpectedEdge,
  TestSuiteOutput,
  VocabularyAnalysis,
} from '../types.js';

/** Build edge phase lookup map from edge requirements */
function buildPhaseMap(requirements: EdgeRequirementsOutput): Map<string, EdgePhase> {
  const map = new Map<string, EdgePhase>();
  for (const req of requirements.requirements) {
    map.set(req.edgeType, req.phase);
  }
  return map;
}

/** Convert an annotated construct into a TestCase */
function buildTestCase(
  ac: AnnotatedConstruct,
  phaseMap: Map<string, EdgePhase>,
): TestCase {
  const expectedNodes: TestExpectedNode[] = ac.annotation.nodes.map((node) => {
    const result: TestExpectedNode = { type: node.type, id: node.id };
    if (node.metadata && Object.keys(node.metadata).length > 0) {
      result.metadata = node.metadata;
    }
    return result;
  });

  const expectedEdges: TestCase['expectedEdges'] = {
    walk: [],
    postFile: [],
    postProject: [],
  };

  for (const edge of ac.annotation.edges) {
    const testEdge: TestExpectedEdge = { src: edge.src, dst: edge.dst, type: edge.type };
    if (edge.metadata && Object.keys(edge.metadata).length > 0) {
      testEdge.metadata = edge.metadata;
    }

    const phase = phaseMap.get(edge.type) ?? 'walk';
    switch (phase) {
      case 'walk':
        expectedEdges.walk.push(testEdge);
        break;
      case 'post-file':
        expectedEdges.postFile.push(testEdge);
        break;
      case 'post-project':
        expectedEdges.postProject.push(testEdge);
        break;
    }
  }

  const testCase: TestCase = {
    constructId: ac.construct.id,
    category: ac.construct.category,
    code: ac.construct.code,
    expectedNodes,
    expectedEdges,
  };

  if (ac.construct.moduleType) {
    testCase.moduleType = ac.construct.moduleType;
  }

  return testCase;
}

/**
 * Compute coverage: which vocabulary types are/aren't exercised by the test suite.
 */
function computeCoverage(
  cases: TestCase[],
  vocab: VocabularyAnalysis,
): TestSuiteOutput['coverage'] {
  const exercisedNodeTypes = new Set<string>();
  const exercisedEdgeTypes = new Set<string>();

  for (const tc of cases) {
    for (const node of tc.expectedNodes) {
      exercisedNodeTypes.add(node.type);
    }
    for (const edge of [...tc.expectedEdges.walk, ...tc.expectedEdges.postFile, ...tc.expectedEdges.postProject]) {
      exercisedEdgeTypes.add(edge.type);
    }
  }

  const allApprovedNodeTypes = new Set<string>();
  const allApprovedEdgeTypes = new Set<string>();

  for (const types of Object.values(vocab.approved.nodeTypes)) {
    for (const t of types) allApprovedNodeTypes.add(t);
  }
  for (const types of Object.values(vocab.approved.edgeTypes)) {
    for (const t of types) allApprovedEdgeTypes.add(t);
  }

  return {
    nodeTypesExercised: [...exercisedNodeTypes].sort(),
    edgeTypesExercised: [...exercisedEdgeTypes].sort(),
    nodeTypesMissing: [...allApprovedNodeTypes].filter((t) => !exercisedNodeTypes.has(t)).sort(),
    edgeTypesMissing: [...allApprovedEdgeTypes].filter((t) => !exercisedEdgeTypes.has(t)).sort(),
  };
}

/**
 * Load merged annotations from pipeline.
 * GREEN from triaged + reannotated YELLOW/RED, with reannotated preferred.
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
 * Compile annotated constructs into a structured test suite.
 *
 * Reads merged annotations and edge requirements, then deterministically
 * builds test cases with edges bucketed by phase. Computes coverage report.
 *
 * @param corpusDir - Path to the corpus directory
 * @returns Test suite output with all cases and coverage report
 */
export async function compileTests(
  corpusDir: string,
): Promise<TestSuiteOutput> {
  const reqPath = join(corpusDir, '.pipeline', '05-edge-requirements.json');
  const reqRaw = await readFile(reqPath, 'utf-8');
  const requirements: EdgeRequirementsOutput = JSON.parse(reqRaw);
  const phaseMap = buildPhaseMap(requirements);

  const vocabPath = join(corpusDir, '.pipeline', '03-vocabulary.json');
  const vocabRaw = await readFile(vocabPath, 'utf-8');
  const vocab: VocabularyAnalysis = JSON.parse(vocabRaw);

  const allAnnotations = await loadMergedAnnotations(corpusDir);

  // Filter out parse errors
  const validAnnotations = allAnnotations.filter(
    (ac) => !ac.annotation.rationale.startsWith('PARSE_ERROR:'),
  );

  process.stderr.write(
    `[compile-tests] ${validAnnotations.length} annotations, ${phaseMap.size} edge type phases\n`,
  );

  const cases = validAnnotations.map((ac) => buildTestCase(ac, phaseMap));

  const coverage = computeCoverage(cases, vocab);

  const output: TestSuiteOutput = {
    language: requirements.language,
    version: requirements.version,
    generatedAt: new Date().toISOString(),
    totalCases: cases.length,
    cases,
    coverage,
  };

  const outputPath = join(corpusDir, '.pipeline', '06-test-suite.json');
  await writeFile(outputPath, JSON.stringify(output, null, 2) + '\n', 'utf-8');

  // Log summary
  const totalWalkEdges = cases.reduce((n, c) => n + c.expectedEdges.walk.length, 0);
  const totalPostFileEdges = cases.reduce((n, c) => n + c.expectedEdges.postFile.length, 0);
  const totalPostProjectEdges = cases.reduce((n, c) => n + c.expectedEdges.postProject.length, 0);

  process.stderr.write(
    `[compile-tests] Complete: ${cases.length} test cases\n` +
      `  Edges: ${totalWalkEdges} walk, ${totalPostFileEdges} post-file, ${totalPostProjectEdges} post-project\n` +
      `  Coverage: ${coverage.nodeTypesExercised.length} node types, ${coverage.edgeTypesExercised.length} edge types\n` +
      `  Missing: ${coverage.nodeTypesMissing.length} node types, ${coverage.edgeTypesMissing.length} edge types\n`,
  );

  return output;
}
