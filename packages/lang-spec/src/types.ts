/**
 * @grafema/lang-spec — Core type definitions
 *
 * Types for the language specification generation pipeline.
 * This package automates: corpus generation → annotation → vocabulary extraction.
 */

// === Language Descriptor ===

/** Input to corpus generation — describes a language for Grafema analysis */
export interface LanguageDescriptor {
  /** Language name, lowercase (e.g., "javascript", "python") */
  name: string;
  /** Language version (e.g., "ES2025", "3.12") */
  version: string;
  /** File extensions including dot (e.g., [".js", ".mjs", ".cjs"]) */
  fileExtensions: string[];
  /** Module system types (e.g., ["esm", "cjs"]) */
  moduleTypes?: string[];
  /** Comment syntax for this language */
  commentSyntax: {
    line: string;
    blockStart: string;
    blockEnd: string;
  };
  /** URL to the language specification */
  specReference?: string;
  /** Base categories to generate corpus files for */
  categories: string[];
  /** Categories that require plugin-specific handling */
  pluginCategories?: Array<{
    name: string;
    plugin: string;
    reason: string;
  }>;
}

// === Construct ===

/** A parsed construct from the corpus — one @construct block */
export interface Construct {
  /** Unique ID: "{category}::{tag}" (e.g., "declarations::var-decl-init") */
  id: string;
  /** Source file path relative to corpus root */
  file: string;
  /** Category derived from filename (e.g., "declarations") */
  category: string;
  /** 1-based line number where construct starts */
  lineStart: number;
  /** 1-based line number where construct ends */
  lineEnd: number;
  /** The source code of the construct */
  code: string;
  /** True if all code lines are comments (commented-out construct) */
  commentedOut: boolean;
  /** Module type if determinable from file extension */
  moduleType?: string;
}

// === Annotation ===

/** LLM annotation output for a single construct */
export interface Annotation {
  /** Expected graph nodes for this construct */
  nodes: AnnotationNode[];
  /** Expected graph edges for this construct */
  edges: AnnotationEdge[];
  /** LLM reasoning about why these nodes/edges are needed */
  rationale: string;
  /** Implicit behaviors not directly visible in code (e.g., hoisting, coercion) */
  implicitBehavior?: string[];
}

export interface AnnotationNode {
  /** Node type (e.g., "VARIABLE", "FUNCTION", "LITERAL") */
  type: string;
  /** Semantic ID within the construct (e.g., "<mutableVar>") */
  id: string;
  /** Optional metadata properties */
  metadata?: Record<string, unknown>;
}

export interface AnnotationEdge {
  /** Source node semantic ID */
  src: string;
  /** Destination node semantic ID */
  dst: string;
  /** Edge type (e.g., "DECLARES", "ASSIGNED_FROM") */
  type: string;
  /** Optional metadata properties */
  metadata?: Record<string, unknown>;
}

// === Annotated Construct (NDJSON record) ===

/** A construct with its annotation — one line in NDJSON output */
export interface AnnotatedConstruct {
  construct: Construct;
  annotation: Annotation;
  /** Pass 1 or Pass 2 */
  pass: 1 | 2;
  /** Timestamp of annotation */
  annotatedAt: string;
}

// === Triage ===

export type TriageColor = 'GREEN' | 'YELLOW' | 'RED';

/** A triaged construct with auto-classification */
export interface TriagedConstruct extends AnnotatedConstruct {
  triage: {
    color: TriageColor;
    reason: string;
  };
}

// === Vocabulary ===

/** Organized vocabulary output — the main deliverable */
export interface Vocabulary {
  nodeTypes: {
    structure: string[];
    declarations: string[];
    values: string[];
    callGraph: string[];
    controlFlow: string[];
    moduleSystem: string[];
    external: string[];
  };
  edgeTypes: {
    containment: string[];
    declaration: string[];
    dataFlow: string[];
    callGraph: string[];
    typeSystem: string[];
    moduleSystem: string[];
    objectStructure: string[];
    controlFlow: string[];
    errorHandling: string[];
    mutation: string[];
  };
  pluginTypes: Record<string, {
    nodeTypes: string[];
    edgeTypes: string[];
  }>;
  deprecated: Array<{
    type: string;
    reason: string;
    replacement?: string;
  }>;
}

/** Intermediate vocabulary analysis — human-editable checkpoint */
export interface VocabularyAnalysis {
  /** Types approved for use (from baseline + confirmed new) */
  approved: {
    nodeTypes: Record<string, string[]>;
    edgeTypes: Record<string, string[]>;
  };
  /** New types discovered with 3+ occurrences */
  new: Array<{
    type: string;
    count: number;
    domain: string;
    examples: string[];
  }>;
  /** Groups of synonymous types that should be merged */
  synonymClusters: string[][];
  /** Baseline types not used in any annotation */
  unused: string[];
  /** Types that belong in plugins, not base vocabulary */
  pluginTerritory: string[];
  /** Types with 1-2 occurrences — likely noise */
  spurious: Array<{
    type: string;
    count: number;
  }>;
}

// === Baseline ===

/** Current Grafema vocabulary extracted from packages/types/ */
export interface BaselineVocabulary {
  nodeTypes: string[];
  edgeTypes: string[];
  namespacedNodeTypes: Record<string, string[]>;
}

// === Pipeline State ===

/** Tracks pipeline execution state for resumability */
export interface PipelineState {
  /** Corpus directory path */
  corpusDir: string;
  /** Language descriptor used */
  language: LanguageDescriptor;
  /** Stage completion status */
  stages: Record<string, {
    completed: boolean;
    startedAt?: string;
    completedAt?: string;
    stats?: Record<string, unknown>;
  }>;
}

// === Gap Report ===

/** Gap found during adversarial review */
export interface CorpusGap {
  category: string;
  construct: string;
  file: string;
  reason: string;
}

/** Review pass result */
export interface ReviewPassResult {
  pass: number;
  gaps: CorpusGap[];
  stats: {
    filesReviewed: number;
    constructsChecked: number;
    gapsFound: number;
  };
}

// === Edge Requirements (Stage 08) ===

/** What context an edge type needs to be created */
export interface EdgeNeeds {
  /** Source and destination in same AST subtree */
  astLocal: boolean;
  /** Needs scope context during walk */
  scopeStack: boolean;
  /** Needs already-created nodes from same file */
  siblingNodes: boolean;
  /** Needs nodes from other files */
  crossFile: boolean;
  /** Needs type inference */
  typeInfo: boolean;
}

/** When an edge type can be created in the analysis pipeline */
export type EdgePhase = 'walk' | 'post-file' | 'post-project';

/** Requirement profile for a single edge type */
export interface EdgeRequirement {
  edgeType: string;
  needs: EdgeNeeds;
  /** Derived: crossFile/typeInfo → post-project, siblingNodes → post-file, else → walk */
  phase: EdgePhase;
  srcNodeTypes: string[];
  dstNodeTypes: string[];
  corpusCount: number;
  /** Up to 5 construct IDs showing this edge type */
  examples: string[];
  /** LLM reasoning about the classification */
  rationale: string;
}

/** Output of Stage 08: classify-edges */
export interface EdgeRequirementsOutput {
  language: string;
  version: string;
  generatedAt: string;
  requirements: EdgeRequirement[];
  phaseDistribution: Record<EdgePhase, string[]>;
}

// === Test Suite (Stage 09) ===

export interface TestExpectedNode {
  type: string;
  id: string;
  metadata?: Record<string, unknown>;
}

export interface TestExpectedEdge {
  src: string;
  dst: string;
  type: string;
  metadata?: Record<string, unknown>;
}

/** A single test case derived from an annotated construct */
export interface TestCase {
  constructId: string;
  category: string;
  code: string;
  moduleType?: string;
  expectedNodes: TestExpectedNode[];
  expectedEdges: {
    walk: TestExpectedEdge[];
    postFile: TestExpectedEdge[];
    postProject: TestExpectedEdge[];
  };
}

/** Output of Stage 09: compile-tests */
export interface TestSuiteOutput {
  language: string;
  version: string;
  generatedAt: string;
  totalCases: number;
  cases: TestCase[];
  coverage: {
    nodeTypesExercised: string[];
    edgeTypesExercised: string[];
    nodeTypesMissing: string[];
    edgeTypesMissing: string[];
  };
}

// === Rule Table + Plugin Scaffold (Stage 10) ===

export interface RuleCondition {
  /** AST node field to check */
  field: string;
  op: 'eq' | 'neq' | 'in' | 'exists' | 'not_exists';
  value?: unknown;
}

export interface NodeTemplate {
  type: string;
  /** e.g., "$name", "$parent.$name" */
  idTemplate: string;
  /** AST field → metadata field */
  metadataMap: Record<string, string>;
}

export interface EdgeTemplate {
  type: string;
  /** e.g., "$parent", "$module", "$self" */
  srcRef: string;
  dstRef: string;
  phase: EdgePhase;
}

export interface Rule {
  astNodeType: string;
  conditions: RuleCondition[];
  emitNodes: NodeTemplate[];
  emitEdges: EdgeTemplate[];
  /** Construct IDs this rule was derived from */
  derivedFrom: string[];
}

export interface RuleTable {
  language: string;
  version: string;
  generatedAt: string;
  rules: Rule[];
}

export interface GeneratedPluginFile {
  path: string;
  className: string;
  phase: 'ANALYSIS' | 'ENRICHMENT';
  createsNodes: string[];
  createsEdges: string[];
  dependencies: string[];
  consumes: string[];
  produces: string[];
}

/** Output of Stage 10: generate-plugin */
export interface PluginScaffoldOutput {
  language: string;
  version: string;
  generatedAt: string;
  plugins: GeneratedPluginFile[];
  ruleTable: RuleTable;
  testFileCount: number;
}

// === CLI ===

export type CliCommand =
  | 'generate'
  | 'annotate'
  | 'parse'
  | 'triage'
  | 'vocabulary'
  | 'reannotate'
  | 'writeback'
  | 'classify-edges'
  | 'compile-tests'
  | 'generate-plugin';

export interface CliOptions {
  command: CliCommand;
  /** Language name (for generate) */
  lang?: string;
  /** Language version (for generate) */
  version?: string;
  /** Corpus directory path */
  corpus?: string;
  /** Output directory (for generate) */
  out?: string;
  /** Resume interrupted operation */
  resume?: boolean;
  /** Number of review passes (for generate) */
  reviewPasses?: number;
  /** Concurrency limit for LLM calls */
  concurrency?: number;
}
