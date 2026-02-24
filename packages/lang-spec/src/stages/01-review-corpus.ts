/**
 * Stage 01 — Review Corpus
 *
 * Adversarial review passes to find gaps in the generated corpus.
 * Each pass reads all source files, sends them to the LLM with instructions
 * to find missing constructs, then appends discovered gaps to the
 * appropriate source files.
 *
 * Stops early if the number of gaps found falls below the threshold,
 * indicating diminishing returns from further review.
 *
 * Input:  corpus directory with src/ files, system prompt at src/prompts/corpus-review.md
 * Output: updated source files with appended constructs, ReviewPassResult[] summary
 */

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { type Dirent } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callLlm } from '../lib/llm.js';
import type { LanguageDescriptor, CorpusGap, ReviewPassResult } from '../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** File extensions to include in review */
const SOURCE_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.py', '.pyw',
]);

/**
 * Load the corpus review system prompt from src/prompts/.
 */
async function loadSystemPrompt(): Promise<string> {
  const promptPath = join(__dirname, '..', 'prompts', 'corpus-review.md');
  return readFile(promptPath, 'utf-8');
}

/**
 * Read all source files from a corpus src/ directory.
 *
 * Returns an array of { name, content } sorted by filename.
 */
async function readSourceFiles(
  srcDir: string,
): Promise<Array<{ name: string; content: string }>> {
  const entries = await readdir(srcDir, { withFileTypes: true });

  const sourceFiles = entries
    .filter((e: Dirent) => e.isFile() && SOURCE_EXTENSIONS.has(extname(e.name)))
    .map((e: Dirent) => e.name)
    .sort();

  const result: Array<{ name: string; content: string }> = [];
  for (const name of sourceFiles) {
    const content = await readFile(join(srcDir, name), 'utf-8');
    result.push({ name, content });
  }
  return result;
}

/**
 * Concatenate source files with headers for LLM context.
 */
function buildFileContext(
  files: Array<{ name: string; content: string }>,
): string {
  return files
    .map((f) => `--- FILE: ${f.name} ---\n${f.content}`)
    .join('\n\n');
}

/**
 * Parse the LLM response as a JSON object with gaps and stats.
 *
 * Handles markdown code fences wrapping the JSON.
 */
function parseReviewResponse(
  text: string,
): { gaps: CorpusGap[]; stats: { filesReviewed: number; constructsChecked: number; gapsFound: number } } {
  let json = text.trim();

  // Strip markdown code fences
  const fencePattern = /^```(?:json)?\n([\s\S]*?)```\s*$/;
  const match = json.match(fencePattern);
  if (match) {
    json = match[1];
  }

  const parsed = JSON.parse(json);

  return {
    gaps: Array.isArray(parsed.gaps) ? parsed.gaps : [],
    stats: parsed.stats ?? {
      filesReviewed: 0,
      constructsChecked: 0,
      gapsFound: Array.isArray(parsed.gaps) ? parsed.gaps.length : 0,
    },
  };
}

/**
 * Append a gap construct to the appropriate source file.
 *
 * Adds a new @construct PENDING block at the end of the target file.
 */
async function appendGapToFile(
  srcDir: string,
  gap: CorpusGap,
  commentPrefix: string,
): Promise<void> {
  const filePath = join(srcDir, gap.file);

  let existing: string;
  try {
    existing = await readFile(filePath, 'utf-8');
  } catch {
    existing = '';
  }

  const tag = gap.construct
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  const appendBlock = [
    '',
    `${commentPrefix} @construct PENDING ${tag}`,
    `${commentPrefix} Gap found: ${gap.reason}`,
    `${commentPrefix} Category: ${gap.category}`,
    '',
  ].join('\n');

  await writeFile(filePath, existing + appendBlock, 'utf-8');
}

/**
 * Run adversarial review passes on the corpus to find missing constructs.
 *
 * Each pass reads all source files, asks the LLM to identify missing
 * patterns, constructs, or edge cases, then appends gap markers to
 * the appropriate files. Stops early if gaps fall below the threshold.
 *
 * @param corpusDir - Path to the corpus directory
 * @param descriptor - Language descriptor for context
 * @param options - Review configuration (maxPasses, gapThreshold)
 * @returns Array of ReviewPassResult, one per pass executed
 */
export async function reviewCorpus(
  corpusDir: string,
  descriptor: LanguageDescriptor,
  options?: { maxPasses?: number; gapThreshold?: number },
): Promise<ReviewPassResult[]> {
  const systemPrompt = await loadSystemPrompt();
  const maxPasses = options?.maxPasses ?? 3;
  const gapThreshold = options?.gapThreshold ?? 5;
  const srcDir = join(corpusDir, 'src');
  const commentPrefix = descriptor.commentSyntax.line;

  const results: ReviewPassResult[] = [];

  for (let pass = 1; pass <= maxPasses; pass++) {
    const files = await readSourceFiles(srcDir);
    const fileContext = buildFileContext(files);

    const userParts = [
      `Review pass: ${pass} of ${maxPasses}`,
      `Language: ${descriptor.name} ${descriptor.version}`,
    ];

    if (descriptor.specReference) {
      userParts.push(`Spec reference: ${descriptor.specReference}`);
    }

    userParts.push(
      '',
      'Current corpus files:',
      '',
      fileContext,
      '',
      'Identify missing constructs, edge cases, and patterns not yet covered.',
      'Return your response as JSON with this shape:',
      '{ "gaps": [{ "category": string, "construct": string, "file": string, "reason": string }], "stats": { "filesReviewed": number, "constructsChecked": number, "gapsFound": number } }',
    );

    const response = await callLlm({
      system: systemPrompt,
      user: userParts.join('\n'),
      model: 'claude-sonnet-4-20250514',
      maxTokens: 4096,
    });

    const { gaps, stats } = parseReviewResponse(response);

    const passResult: ReviewPassResult = {
      pass,
      gaps,
      stats: {
        filesReviewed: stats.filesReviewed || files.length,
        constructsChecked: stats.constructsChecked,
        gapsFound: gaps.length,
      },
    };

    results.push(passResult);

    process.stderr.write(
      `[review] Pass ${pass}: ${gaps.length} gaps found` +
        ` (${passResult.stats.filesReviewed} files, ${passResult.stats.constructsChecked} constructs checked)\n`,
    );

    if (gaps.length < gapThreshold) {
      process.stderr.write(
        `[review] Gaps (${gaps.length}) below threshold (${gapThreshold}), stopping\n`,
      );
      break;
    }

    // Append discovered gaps to the appropriate files
    for (const gap of gaps) {
      await appendGapToFile(srcDir, gap, commentPrefix);
    }

    process.stderr.write(
      `[review] Appended ${gaps.length} gap markers to source files\n`,
    );
  }

  const totalGaps = results.reduce((sum, r) => sum + r.gaps.length, 0);
  process.stderr.write(
    `[review] Complete: ${results.length} passes, ${totalGaps} total gaps found\n`,
  );

  return results;
}
