#!/usr/bin/env node
/**
 * Autoresearch answer evaluator.
 *
 * Compares answers from a run against expected answers in questions.yaml.
 * Supports eval_type: set, superset, text, judge.
 *
 * Usage:
 *   node autoresearch/harness/evaluate.mjs --run autoresearch/results/{run-id}
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, resolve, basename } from 'path';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { createRequire } from 'module';

const _require = createRequire(join(resolve(new URL('../../', import.meta.url).pathname), 'packages', 'util', 'package.json'));
const { parse: parseYAML } = _require('yaml');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROJECT_ROOT = resolve(new URL('../../', import.meta.url).pathname);
const DEFAULT_QUESTIONS = join(PROJECT_ROOT, 'autoresearch', 'questions.yaml');

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    run: null,
    questions: DEFAULT_QUESTIONS,
    judge: false,
    judgeModel: 'haiku',
  };
  let i = 2;
  while (i < argv.length) {
    switch (argv[i]) {
      case '--run':
        args.run = resolve(argv[++i]);
        break;
      case '--questions':
        args.questions = resolve(argv[++i]);
        break;
      case '--judge':
        args.judge = true;
        break;
      case '--judge-model':
        args.judgeModel = argv[++i];
        break;
      case '--help':
      case '-h':
        console.error('Usage: node evaluate.mjs --run autoresearch/results/{run-id} [--questions path] [--judge] [--judge-model haiku]');
        process.exit(0);
        break;
      default:
        console.error(`Unknown argument: ${argv[i]}`);
        process.exit(1);
    }
    i++;
  }
  if (!args.run) {
    console.error('Error: --run is required');
    process.exit(1);
  }
  return args;
}

// ---------------------------------------------------------------------------
// YAML helpers
// ---------------------------------------------------------------------------

function loadQuestions(path) {
  const raw = readFileSync(path, 'utf8');
  const data = parseYAML(raw);
  return Array.isArray(data) ? data : data.questions;
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a single answer item for comparison.
 * - lowercase
 * - trim whitespace
 * - remove trailing .ts/.js extensions
 * - for file paths: extract basename, remove leading ./
 * - remove trailing slashes
 */
function normalize(s) {
  let v = s.toLowerCase().trim();
  // Remove leading list markers: "- ", "* ", "1. ", etc.
  v = v.replace(/^[-*]\s+/, '').replace(/^\d+\.\s+/, '');
  // Remove backticks (code formatting)
  v = v.replace(/`/g, '');
  // Remove trailing slash
  v = v.replace(/\/+$/, '');
  // Remove .ts/.js/.mjs/.cjs extensions for flexible matching
  v = v.replace(/\.(ts|js|mjs|cjs)$/, '');
  // If it looks like a path, also prepare a basename version
  // We store the normalized full form; basename comparison is done separately
  return v;
}

/**
 * Extract basename from a path-like string (after normalization).
 */
function extractBasename(s) {
  return basename(s);
}

/**
 * Parse the answer_text into a list of items.
 * Splits by newlines, commas (if single-line), filters empty.
 */
function parseAnswerItems(text) {
  if (!text) return [];
  // Split by newlines first
  let items = text.split('\n').map(s => s.trim()).filter(Boolean);
  // If single line with commas, split by comma
  if (items.length === 1 && items[0].includes(',')) {
    items = items[0].split(',').map(s => s.trim()).filter(Boolean);
  }
  return items;
}

// ---------------------------------------------------------------------------
// Evaluation functions
// ---------------------------------------------------------------------------

function evalSet(expected, actual) {
  const actNorm = actual.map(normalize);
  const actBase = actual.map(a => normalize(extractBasename(a)));

  // Check that every expected item matches some actual item (recall)
  let recallHits = 0;
  for (const exp of expected) {
    if (itemMatches(normalize(exp), normalize(extractBasename(exp)), actNorm, actBase)) {
      recallHits++;
    }
  }

  // Check that every actual item matches some expected item (precision)
  const expNorm = expected.map(normalize);
  const expBase = expected.map(e => normalize(extractBasename(e)));
  let precisionHits = 0;
  for (const act of actual) {
    if (itemMatches(normalize(act), normalize(extractBasename(act)), expNorm, expBase)) {
      precisionHits++;
    }
  }

  const recall = expected.length > 0 ? recallHits / expected.length : 1.0;
  const precision = actual.length > 0 ? precisionHits / actual.length : 1.0;
  const correct = recall === 1.0 && precision === 1.0;
  const score = correct ? 1.0 : 0.0;
  return { score, correct };
}

/**
 * Check if an expected item matches any actual item.
 * Tries: exact match, basename match, prefix match, substring match.
 * Also tries with common file extensions since normalize() only strips
 * extensions at end-of-string, but prose answers have paths mid-line.
 */
function itemMatches(expectedNorm, expectedBase, actualItems, actualBases) {
  // Build variants: with and without common extensions
  const exts = ['', '.ts', '.js', '.mjs', '.cjs', '.rs'];
  const expectedVariants = exts.map(ext => expectedNorm + ext);
  const baseVariants = exts.map(ext => expectedBase + ext);

  for (const en of expectedVariants) {
    // Exact match
    if (actualItems.some(a => a === en)) return true;
    // Prefix match: actual starts with expected (+ word boundary or end)
    if (actualItems.some(a => a.startsWith(en + ' ') || a.startsWith(en + '/') || a === en)) return true;
    // Substring match: expected appears as a bounded token in actual
    const re = new RegExp('(^|[\\s/`])' + en.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[\\s/,;:\\-—`])');
    if (actualItems.some(a => re.test(a))) return true;
  }

  for (const eb of baseVariants) {
    if (actualBases.some(a => a === eb)) return true;
    if (actualBases.some(a => a.startsWith(eb + ' ') || a === eb)) return true;
  }

  return false;
}

function evalSuperset(expected, actual) {
  const actNorm = actual.map(normalize);
  const actBase = actual.map(a => normalize(extractBasename(a)));

  let found = 0;
  for (const exp of expected) {
    const en = normalize(exp);
    const eb = normalize(extractBasename(exp));
    if (itemMatches(en, eb, actNorm, actBase)) {
      found++;
    }
  }

  const score = expected.length > 0 ? found / expected.length : 1.0;
  return { score, correct: score === 1.0 };
}

// ---------------------------------------------------------------------------
// LLM Judge
// ---------------------------------------------------------------------------

const JUDGE_MODEL_MAP = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6',
};

/**
 * Use an LLM to judge answer quality on a 0-5 scale.
 * Spawns `claude -p` with a judging prompt.
 * Returns { score: 0-5, reasoning: string }.
 */
function evalJudge(question, referenceAnswer, actualAnswer, modelAlias) {
  const modelId = JUDGE_MODEL_MAP[modelAlias] || modelAlias;

  const prompt = `You are an expert code reviewer evaluating answers about a codebase.

QUESTION:
${question}

REFERENCE ANSWER (ground truth):
${referenceAnswer}

ACTUAL ANSWER (to evaluate):
${actualAnswer}

Score the actual answer on a 0-5 scale:
- 5: Perfect — all key points from reference covered accurately
- 4: Very good — minor omissions or imprecisions, core is correct
- 3: Adequate — covers main idea but misses important details
- 2: Partial — some correct elements but significant gaps or errors
- 1: Poor — mostly incorrect or irrelevant
- 0: Wrong — completely incorrect or empty

Respond in exactly this format (no other text):
SCORE: <number>
REASONING: <one sentence>`;

  const tmpFile = join(tmpdir(), `judge-prompt-${process.pid}-${Date.now()}.txt`);
  writeFileSync(tmpFile, prompt, 'utf8');

  try {
    const result = execFileSync('claude', [
      '-p', prompt,
      '--output-format', 'text',
      '--max-turns', '1',
      '--model', modelId,
      '--dangerously-skip-permissions',
      '--no-session-persistence',
    ], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      timeout: 60000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Parse response
    const scoreMatch = result.match(/SCORE:\s*(\d)/);
    const reasonMatch = result.match(/REASONING:\s*(.+)/);

    const score = scoreMatch ? parseInt(scoreMatch[1], 10) : null;
    const reasoning = reasonMatch ? reasonMatch[1].trim() : result.trim().slice(0, 200);

    return { score, reasoning };
  } catch (err) {
    console.error(`  Judge error: ${err.message?.slice(0, 100)}`);
    return { score: null, reasoning: `error: ${err.message?.slice(0, 100)}` };
  } finally {
    try { require('fs').unlinkSync(tmpFile); } catch {}
  }
}

function evalText(expected, answerText) {
  // expected is a list of keywords that should all be present
  const text = (answerText || '').toLowerCase();
  let found = 0;
  const missing = [];
  for (const keyword of expected) {
    if (text.includes(keyword.toLowerCase())) {
      found++;
    } else {
      missing.push(keyword);
    }
  }
  const score = expected.length > 0 ? found / expected.length : 1.0;
  return { score, correct: score === 1.0, missing };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv);

  // Load questions
  const questions = loadQuestions(args.questions);
  const questionMap = new Map(questions.map(q => [q.id, q]));

  // Load answers
  const answersPath = join(args.run, 'answers.jsonl');
  if (!existsSync(answersPath)) {
    console.error(`Error: ${answersPath} not found`);
    process.exit(1);
  }
  const answerLines = readFileSync(answersPath, 'utf8').split('\n').filter(Boolean);
  const answers = answerLines.map(line => JSON.parse(line));
  const answerMap = new Map(answers.map(a => [a.question_id, a]));

  const evalPath = join(args.run, 'evaluation.jsonl');
  // Clear previous evaluation
  if (existsSync(evalPath)) writeFileSync(evalPath, '', 'utf8');

  let deterministic = 0;
  let correct = 0;
  let judgeSkipped = 0;
  let errored = 0;
  const results = [];

  for (const q of questions) {
    const answer = answerMap.get(q.id);
    if (!answer) {
      // Skip silently if this is a partial run (not all questions were run)
      continue;
    }

    if (answer.error) {
      console.error(`  ${q.id}: ERROR (${answer.error})`);
      errored++;
      continue;
    }

    const evalType = q.eval_type || 'judge';
    const expected = q.expected || [];

    if (evalType === 'judge') {
      if (!args.judge) {
        judgeSkipped++;
        const entry = {
          question_id: q.id,
          eval_type: 'judge',
          score: null,
          expected,
          actual: answer.answer_text,
          correct: null,
          status: 'needs_judge',
        };
        results.push(entry);
        writeFileSync(evalPath, JSON.stringify(entry) + '\n', { flag: 'a' });
        continue;
      }

      // Run LLM judge
      const refAnswer = q.reference_answer || '';
      console.error(`  ${q.id}: judging...`);
      // Use raw_text as fallback when answer_text is empty (agent didn't use <answer> tags)
      const textToJudge = answer.answer_text || answer.raw_text || '';
      const judgeResult = evalJudge(q.question, refAnswer, textToJudge, args.judgeModel);
      const normalizedScore = judgeResult.score !== null ? judgeResult.score / 5.0 : null;
      const entry = {
        question_id: q.id,
        eval_type: 'judge',
        score: normalizedScore,
        judge_raw_score: judgeResult.score,
        reasoning: judgeResult.reasoning,
        expected: refAnswer.slice(0, 200) + '...',
        actual: answer.answer_text.slice(0, 200) + '...',
        correct: judgeResult.score !== null ? judgeResult.score >= 3 : null,
        status: 'judged',
      };
      results.push(entry);
      writeFileSync(evalPath, JSON.stringify(entry) + '\n', { flag: 'a' });

      const mark = entry.correct ? 'PASS' : (entry.correct === false ? 'FAIL' : '?');
      console.error(`  ${q.id}: ${mark} (${judgeResult.score}/5) — ${judgeResult.reasoning?.slice(0, 80)}`);
      if (entry.correct) correct++;
      deterministic++;
      continue;
    }

    deterministic++;
    const actualItems = parseAnswerItems(answer.answer_text);

    let evalResult;
    switch (evalType) {
      case 'set':
        evalResult = evalSet(expected, actualItems);
        break;
      case 'superset':
        evalResult = evalSuperset(expected, actualItems);
        break;
      case 'text':
        evalResult = evalText(expected, answer.answer_text);
        break;
      default:
        console.error(`  ${q.id}: unknown eval_type "${evalType}"`);
        evalResult = { score: 0, correct: false };
    }

    if (evalResult.correct) correct++;

    const entry = {
      question_id: q.id,
      eval_type: evalType,
      score: evalResult.score,
      expected,
      actual: actualItems,
      correct: evalResult.correct,
    };
    if (evalResult.missing) entry.missing = evalResult.missing;
    results.push(entry);
    writeFileSync(evalPath, JSON.stringify(entry) + '\n', { flag: 'a' });

    const mark = evalResult.correct ? 'PASS' : 'FAIL';
    const scoreStr = evalResult.score === 1.0 ? '1.0' : evalResult.score.toFixed(2);
    console.error(`  ${q.id}: ${mark} (${scoreStr}) [${evalType}]`);
  }

  console.error('');
  console.error(`=== Evaluation Summary ===`);
  console.error(`${deterministic} deterministic questions evaluated. ${correct} correct, ${deterministic - correct} incorrect.`);
  if (judgeSkipped > 0) console.error(`${judgeSkipped} judge questions skipped.`);
  if (errored > 0) console.error(`${errored} questions errored/missing.`);
  console.error(`Results: ${evalPath}`);
}

main();
