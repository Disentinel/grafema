#!/usr/bin/env node
/**
 * @grafema/lang-spec CLI entry point
 *
 * Drives the language specification pipeline from the command line.
 * No external CLI framework — parses process.argv manually.
 *
 * Usage:
 *   npx tsx packages/lang-spec/src/cli.ts <command> [options]
 *
 * Commands:
 *   generate    Generate corpus for a new language
 *   annotate    Run annotation Pass 1 on parsed corpus
 *   parse       Parse @construct blocks from corpus files
 *   triage      Auto-classify annotated constructs
 *   vocabulary  Extract and organize vocabulary
 *   reannotate  Run annotation Pass 2 (vocabulary-constrained)
 *   writeback   Insert annotations into source files
 *
 * Options:
 *   --lang <name>       Language name (for generate)
 *   --version <ver>     Language version (for generate)
 *   --corpus <path>     Path to corpus directory
 *   --out <path>        Output directory (for generate)
 *   --resume            Resume interrupted annotation
 *   --review-passes <n> Number of review passes (default: 3)
 *   --concurrency <n>   Max concurrent LLM calls (default: 10)
 */

import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { CliCommand, CliOptions, LanguageDescriptor } from './types.js';
import { generateCorpus } from './stages/00-generate-corpus.js';
import { reviewCorpus } from './stages/01-review-corpus.js';
import { parseCorpus } from './stages/02-parse-corpus.js';
import { annotateCorpus } from './stages/03-annotate.js';
import { triageAnnotations } from './stages/04-triage.js';
import { extractVocabulary } from './stages/05-vocabulary.js';
import { reannotateCorpus } from './stages/06-reannotate.js';
import { writebackAnnotations } from './stages/07-writeback.js';
import { classifyEdges } from './stages/08-classify-edges.js';
import { compileTests } from './stages/09-compile-tests.js';
import { generatePlugin } from './stages/10-generate-plugin.js';

const VALID_COMMANDS = new Set<CliCommand>([
  'generate',
  'annotate',
  'parse',
  'triage',
  'vocabulary',
  'reannotate',
  'writeback',
  'classify-edges',
  'compile-tests',
  'generate-plugin',
]);

const USAGE = `Usage: npx tsx packages/lang-spec/src/cli.ts <command> [options]

Commands:
  generate        Generate corpus for a new language
  annotate        Run annotation Pass 1 on parsed corpus
  parse           Parse @construct blocks from corpus files
  triage          Auto-classify annotated constructs
  vocabulary      Extract and organize vocabulary
  reannotate      Run annotation Pass 2 (vocabulary-constrained)
  writeback       Insert annotations into source files
  classify-edges  Classify edge types by requirement profile (LLM)
  compile-tests   Compile annotations into test suite
  generate-plugin Generate plugin scaffolds from rule table

Options:
  --lang <name>       Language name (for generate)
  --version <ver>     Language version (for generate)
  --corpus <path>     Path to corpus directory
  --out <path>        Output directory (for generate)
  --resume            Resume interrupted annotation
  --review-passes <n> Number of review passes (default: 3)
  --concurrency <n>   Max concurrent LLM calls (default: 10)
`;

/**
 * Parse command-line arguments into a structured CliOptions object.
 *
 * First positional argument is the command. Named options use --key value
 * or --flag (boolean) syntax. Numeric options are parsed as integers.
 */
function parseArgs(argv: string[]): CliOptions {
  const args = argv.slice(2);

  if (args.length === 0) {
    process.stderr.write(USAGE);
    process.exit(1);
  }

  const command = args[0] as CliCommand;

  if (!VALID_COMMANDS.has(command)) {
    process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
    process.exit(1);
  }

  const options: CliOptions = { command };
  let i = 1;

  while (i < args.length) {
    const arg = args[i];

    switch (arg) {
      case '--lang':
        options.lang = args[++i];
        break;
      case '--version':
        options.version = args[++i];
        break;
      case '--corpus':
        options.corpus = args[++i];
        break;
      case '--out':
        options.out = args[++i];
        break;
      case '--resume':
        options.resume = true;
        break;
      case '--review-passes':
        options.reviewPasses = parseInt(args[++i], 10);
        break;
      case '--concurrency':
        options.concurrency = parseInt(args[++i], 10);
        break;
      default:
        process.stderr.write(`Unknown option: ${arg}\n\n${USAGE}`);
        process.exit(1);
    }
    i++;
  }

  return options;
}

/**
 * Load a language descriptor JSON file from data/languages/{lang}.json.
 *
 * Resolves the path relative to the CLI source file location via
 * import.meta.url so it works regardless of the working directory.
 */
async function loadLanguageDescriptor(
  lang: string,
  versionOverride?: string,
): Promise<LanguageDescriptor> {
  const descriptorPath = fileURLToPath(
    new URL(`../data/languages/${lang}.json`, import.meta.url),
  );

  let raw: string;
  try {
    raw = await readFile(descriptorPath, 'utf-8');
  } catch {
    throw new Error(
      `Language descriptor not found: ${descriptorPath}\n` +
        `Create data/languages/${lang}.json with the language descriptor.`,
    );
  }

  const descriptor: LanguageDescriptor = JSON.parse(raw);

  if (versionOverride) {
    descriptor.version = versionOverride;
  }

  return descriptor;
}

/**
 * Require that an option is present, or exit with an error message.
 */
function requireOption(
  value: string | undefined,
  name: string,
  command: string,
): asserts value is string {
  if (!value) {
    process.stderr.write(`Error: --${name} is required for '${command}'\n`);
    process.exit(1);
  }
}

/**
 * Run the CLI command specified by the parsed options.
 *
 * Each command validates its required options, then delegates to the
 * corresponding stage function from src/stages/.
 */
async function run(options: CliOptions): Promise<void> {
  switch (options.command) {
    case 'generate': {
      requireOption(options.lang, 'lang', 'generate');
      requireOption(options.out, 'out', 'generate');

      const descriptor = await loadLanguageDescriptor(
        options.lang,
        options.version,
      );
      const outDir = resolve(options.out);
      const reviewPasses = options.reviewPasses ?? 3;

      process.stderr.write(
        `[cli] Generating corpus for ${descriptor.name} ${descriptor.version}\n`,
      );
      await generateCorpus(descriptor, outDir);

      process.stderr.write(
        `[cli] Running ${reviewPasses} adversarial review pass(es)\n`,
      );
      await reviewCorpus(outDir, descriptor, { maxPasses: reviewPasses });
      break;
    }

    case 'parse': {
      requireOption(options.corpus, 'corpus', 'parse');
      const corpusDir = resolve(options.corpus);
      await parseCorpus(corpusDir);
      break;
    }

    case 'annotate': {
      requireOption(options.corpus, 'corpus', 'annotate');
      const corpusDir = resolve(options.corpus);
      await annotateCorpus(corpusDir, {
        concurrency: options.concurrency,
        resume: options.resume,
      });
      break;
    }

    case 'triage': {
      requireOption(options.corpus, 'corpus', 'triage');
      const corpusDir = resolve(options.corpus);
      await triageAnnotations(corpusDir);
      break;
    }

    case 'vocabulary': {
      requireOption(options.corpus, 'corpus', 'vocabulary');
      const corpusDir = resolve(options.corpus);
      await extractVocabulary(corpusDir);
      break;
    }

    case 'reannotate': {
      requireOption(options.corpus, 'corpus', 'reannotate');
      const corpusDir = resolve(options.corpus);
      await reannotateCorpus(corpusDir, {
        concurrency: options.concurrency,
        resume: options.resume,
      });
      break;
    }

    case 'writeback': {
      requireOption(options.corpus, 'corpus', 'writeback');
      const corpusDir = resolve(options.corpus);
      await writebackAnnotations(corpusDir);
      break;
    }

    case 'classify-edges': {
      requireOption(options.corpus, 'corpus', 'classify-edges');
      const corpusDir = resolve(options.corpus);
      await classifyEdges(corpusDir, {
        concurrency: options.concurrency,
        resume: options.resume,
      });
      break;
    }

    case 'compile-tests': {
      requireOption(options.corpus, 'corpus', 'compile-tests');
      const corpusDir = resolve(options.corpus);
      await compileTests(corpusDir);
      break;
    }

    case 'generate-plugin': {
      requireOption(options.corpus, 'corpus', 'generate-plugin');
      const corpusDir = resolve(options.corpus);
      await generatePlugin(corpusDir, {
        concurrency: options.concurrency,
      });
      break;
    }
  }
}

const options = parseArgs(process.argv);

run(options).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[cli] Error: ${message}\n`);
  process.exit(1);
});
