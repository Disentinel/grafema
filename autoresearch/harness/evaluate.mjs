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
      case '--help':
      case '-h':
        console.error('Usage: node evaluate.mjs --run autoresearch/results/{run-id} [--questions path]');
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
  const expSet = new Set(expected.map(normalize));
  const actSet = new Set(actual.map(normalize));

  // Also try basename matching for file paths
  const expBaseSet = new Set(expected.map(e => normalize(extractBasename(e))));
  const actBaseSet = new Set(actual.map(a => normalize(extractBasename(a))));

  // Check exact set equality (full paths or basenames)
  const fullMatch = expSet.size === actSet.size && [...expSet].every(e => actSet.has(e));
  const baseMatch = expBaseSet.size === actBaseSet.size && [...expBaseSet].every(e => actBaseSet.has(e));

  const score = (fullMatch || baseMatch) ? 1.0 : 0.0;
  return { score, correct: score === 1.0 };
}

function evalSuperset(expected, actual) {
  const actNorm = new Set(actual.map(normalize));
  const actBase = new Set(actual.map(a => normalize(extractBasename(a))));

  let found = 0;
  for (const exp of expected) {
    const en = normalize(exp);
    const eb = normalize(extractBasename(exp));
    if (actNorm.has(en) || actBase.has(eb)) {
      found++;
    }
  }

  const score = expected.length > 0 ? found / expected.length : 1.0;
  return { score, correct: score === 1.0 };
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
      console.error(`  ${q.id}: MISSING (no answer in run)`);
      errored++;
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
