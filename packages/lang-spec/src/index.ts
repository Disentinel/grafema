/**
 * @grafema/lang-spec — Language Specification Generator
 *
 * Automates the pipeline from language descriptor to annotated corpus
 * with clean, layered graph vocabulary, then to actionable outputs:
 * edge requirement profiles, compiled test suites, and generated plugins.
 *
 * Pipeline stages:
 *   0. Generate corpus (LLM) — fixture files with @construct markers
 *   1. Review corpus (LLM) — adversarial gap detection
 *   2. Parse corpus — extract @construct blocks to NDJSON
 *   3. Annotate Pass 1 (LLM) — unconstrained annotation
 *   4. Triage — auto-classify GREEN/YELLOW/RED
 *   5. Vocabulary — extract + cluster + organize types
 *   6. Reannotate Pass 2 (LLM) — vocabulary-constrained
 *   7. Writeback — insert annotations into source files
 *   8. Classify edges (LLM) — edge type requirement profiles
 *   9. Compile tests — deterministic annotation → test cases
 *  10. Generate plugin — rule table + plugin scaffolds
 */

export type {
  LanguageDescriptor,
  Construct,
  Annotation,
  AnnotationNode,
  AnnotationEdge,
  AnnotatedConstruct,
  TriageColor,
  TriagedConstruct,
  Vocabulary,
  VocabularyAnalysis,
  BaselineVocabulary,
  PipelineState,
  CorpusGap,
  ReviewPassResult,
  CliCommand,
  CliOptions,
  EdgeNeeds,
  EdgePhase,
  EdgeRequirement,
  EdgeRequirementsOutput,
  TestExpectedNode,
  TestExpectedEdge,
  TestCase,
  TestSuiteOutput,
  RuleCondition,
  NodeTemplate,
  EdgeTemplate,
  Rule,
  RuleTable,
  GeneratedPluginFile,
  PluginScaffoldOutput,
} from './types.js';

export { parseCorpus } from './stages/02-parse-corpus.js';
export { annotateCorpus } from './stages/03-annotate.js';
export { triageAnnotations } from './stages/04-triage.js';
export { extractVocabulary } from './stages/05-vocabulary.js';
export { reannotateCorpus } from './stages/06-reannotate.js';
export { writebackAnnotations } from './stages/07-writeback.js';
export { generateCorpus } from './stages/00-generate-corpus.js';
export { reviewCorpus } from './stages/01-review-corpus.js';
export { classifyEdges } from './stages/08-classify-edges.js';
export { compileTests } from './stages/09-compile-tests.js';
export { generatePlugin } from './stages/10-generate-plugin.js';
