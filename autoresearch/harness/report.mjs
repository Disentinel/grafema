#!/usr/bin/env node
/**
 * Autoresearch report generator.
 *
 * Compares two (or more) runs and generates a markdown report with
 * accuracy, token usage, latency, cost, and MCP adoption metrics.
 *
 * Usage:
 *   node autoresearch/harness/report.mjs --runs autoresearch/results/run1,autoresearch/results/run2
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, join, basename } from 'path';
import { createRequire } from 'module';

const _require = createRequire(join(resolve(new URL('../../', import.meta.url).pathname), 'packages', 'util', 'package.json'));
const { parse: parseYAML } = _require('yaml');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROJECT_ROOT = resolve(new URL('../../', import.meta.url).pathname);
const DEFAULT_QUESTIONS = join(PROJECT_ROOT, 'autoresearch', 'questions.yaml');

// Cost per 1M tokens
const COST_TABLE = {
  'claude-sonnet-4-6':           { input: 3,     output: 15    },
  'claude-opus-4-6':             { input: 15,    output: 75    },
  'claude-haiku-4-5-20251001':   { input: 0.25,  output: 1.25  },
};

// Cache read tokens cost 10% of input price
const CACHE_READ_DISCOUNT = 0.1;

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    runs: [],
    questions: DEFAULT_QUESTIONS,
  };
  let i = 2;
  while (i < argv.length) {
    switch (argv[i]) {
      case '--runs':
        args.runs = argv[++i].split(',').map(p => resolve(p.trim()));
        break;
      case '--questions':
        args.questions = resolve(argv[++i]);
        break;
      case '--help':
      case '-h':
        console.error('Usage: node report.mjs --runs run1,run2 [--questions path]');
        process.exit(0);
        break;
      default:
        console.error(`Unknown argument: ${argv[i]}`);
        process.exit(1);
    }
    i++;
  }
  if (args.runs.length < 2) {
    console.error('Error: --runs requires at least 2 comma-separated run directories');
    process.exit(1);
  }
  return args;
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

function loadQuestions(path) {
  const raw = readFileSync(path, 'utf8');
  const data = parseYAML(raw);
  return Array.isArray(data) ? data : data.questions;
}

function loadRunData(runDir) {
  const configPath = join(runDir, 'config.yaml');
  const answersPath = join(runDir, 'answers.jsonl');
  const evalPath = join(runDir, 'evaluation.jsonl');

  if (!existsSync(configPath)) {
    console.error(`Error: ${configPath} not found`);
    process.exit(1);
  }

  const config = parseYAML(readFileSync(configPath, 'utf8'));

  const answers = existsSync(answersPath)
    ? readFileSync(answersPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
    : [];

  const evals = existsSync(evalPath)
    ? readFileSync(evalPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
    : [];

  const answerMap = new Map(answers.map(a => [a.question_id, a]));
  const evalMap = new Map(evals.map(e => [e.question_id, e]));

  return { config, answers, evals, answerMap, evalMap, dir: runDir };
}

// ---------------------------------------------------------------------------
// Cost estimation
// ---------------------------------------------------------------------------

function estimateCost(answer) {
  const model = answer.model || '';
  const rates = COST_TABLE[model];
  if (!rates) return 0;

  const inputCost = ((answer.input_tokens || 0) / 1_000_000) * rates.input;
  const outputCost = ((answer.output_tokens || 0) / 1_000_000) * rates.output;
  const cacheReadCost = ((answer.cache_read_tokens || 0) / 1_000_000) * rates.input * CACHE_READ_DISCOUNT;
  const cacheCreateCost = ((answer.cache_creation_tokens || 0) / 1_000_000) * rates.input;

  return inputCost + outputCost + cacheReadCost + cacheCreateCost;
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------

function generateReport(runs, questions) {
  const lines = [];
  const w = (s) => lines.push(s);

  const run1 = runs[0];
  const run2 = runs[1];

  const mode1 = run1.config.mode;
  const mode2 = run2.config.mode;
  const model = run1.config.model || run2.config.model || 'unknown';
  const date = run1.config.date || new Date().toISOString();

  w(`# Autoresearch Report: ${mode1} vs ${mode2}`);
  w(`Date: ${date.split('T')[0]}`);
  w(`Model: ${model}`);
  w('');

  // --- Summary metrics ---
  const metrics = runs.map(run => {
    const detEvals = run.evals.filter(e => e.eval_type !== 'judge' && e.score !== null);
    const correctCount = detEvals.filter(e => e.correct).length;
    const detTotal = detEvals.length;
    const accuracy = detTotal > 0 ? correctCount / detTotal : 0;

    const validAnswers = run.answers.filter(a => !a.error);
    const totalTokens = validAnswers.reduce((s, a) => s + (a.input_tokens || 0) + (a.output_tokens || 0), 0);
    const avgTokens = validAnswers.length > 0 ? Math.round(totalTokens / validAnswers.length) : 0;

    const totalLatency = validAnswers.reduce((s, a) => s + (a.latency_ms || 0), 0);
    const avgLatency = validAnswers.length > 0 ? Math.round(totalLatency / validAnswers.length / 1000) : 0;

    const totalMcp = validAnswers.reduce((s, a) => s + (a.mcp_calls || 0), 0);
    const mcpQuestions = validAnswers.filter(a => (a.mcp_calls || 0) > 0).length;
    const mcpAdoption = validAnswers.length > 0 ? mcpQuestions / validAnswers.length : 0;

    const totalCost = validAnswers.reduce((s, a) => s + estimateCost(a), 0);

    return {
      correctCount,
      detTotal,
      accuracy,
      avgTokens,
      avgLatency,
      mcpAdoption,
      totalCost,
      totalMcp,
      mcpQuestions,
      validCount: validAnswers.length,
    };
  });

  const m1 = metrics[0];
  const m2 = metrics[1];

  function pct(v) { return `${Math.round(v * 100)}%`; }
  function delta(a, b, invert = false) {
    if (a === 0 && b === 0) return '-';
    const d = b - a;
    const pctDelta = a !== 0 ? Math.round((d / a) * 100) : (d > 0 ? 100 : -100);
    const sign = pctDelta > 0 ? '+' : '';
    return `${sign}${pctDelta}%`;
  }

  w('## Summary');
  w(`| Metric | ${mode1} | ${mode2} | Delta |`);
  w('|--------|' + '-'.repeat(mode1.length + 2) + '|' + '-'.repeat(mode2.length + 2) + '|-------|');
  w(`| Accuracy (det.) | ${pct(m1.accuracy)} (${m1.correctCount}/${m1.detTotal}) | ${pct(m2.accuracy)} (${m2.correctCount}/${m2.detTotal}) | ${delta(m1.accuracy, m2.accuracy)} |`);
  w(`| Avg tokens | ${m1.avgTokens} | ${m2.avgTokens} | ${delta(m1.avgTokens, m2.avgTokens)} |`);
  w(`| Avg latency | ${m1.avgLatency}s | ${m2.avgLatency}s | ${delta(m1.avgLatency, m2.avgLatency)} |`);
  w(`| MCP adoption | ${pct(m1.mcpAdoption)} | ${pct(m2.mcpAdoption)} | ${delta(m1.mcpAdoption, m2.mcpAdoption)} |`);
  w(`| Est. cost | $${m1.totalCost.toFixed(2)} | $${m2.totalCost.toFixed(2)} | ${delta(m1.totalCost, m2.totalCost)} |`);
  w('');

  // --- Per-question comparison ---
  w('## Per-Question Comparison');
  w(`| Q | Category | ${mode1} | ${mode2} | Winner |`);
  w(`|---|----------|${'-'.repeat(mode1.length + 2)}|${'-'.repeat(mode2.length + 2)}|--------|`);

  for (const q of questions) {
    const e1 = run1.evalMap.get(q.id);
    const e2 = run2.evalMap.get(q.id);

    const category = q.category || '';

    function formatScore(ev) {
      if (!ev) return '- (N/A)';
      if (ev.status === 'needs_judge') return '? (judge)';
      if (ev.score === null) return '- (N/A)';
      const mark = ev.correct ? '\u2713' : '\u2717';
      return `${mark} (${ev.score === 1.0 ? '1.0' : ev.score.toFixed(1)})`;
    }

    let winner = 'tie';
    if (e1 && e2 && e1.score !== null && e2.score !== null) {
      if (e2.score > e1.score) winner = mode2;
      else if (e1.score > e2.score) winner = mode1;
    }

    w(`| ${q.id} | ${category} | ${formatScore(e1)} | ${formatScore(e2)} | ${winner} |`);
  }
  w('');

  // --- Tool usage for grafema mode ---
  const grafemaRun = runs.find(r => r.config.mode === 'grafema');
  if (grafemaRun) {
    w('## Tool Usage (grafema mode)');

    // Aggregate tool calls across all answers
    const toolAgg = {};
    const toolQuestions = {};
    for (const a of grafemaRun.answers) {
      if (a.error) continue;
      for (const tc of (a.tool_calls || [])) {
        toolAgg[tc.name] = (toolAgg[tc.name] || 0) + tc.count;
        if (!toolQuestions[tc.name]) toolQuestions[tc.name] = [];
        toolQuestions[tc.name].push(a.question_id);
      }
    }

    const sortedTools = Object.entries(toolAgg).sort((a, b) => b[1] - a[1]);

    w('| Tool | Calls | Questions Used In |');
    w('|------|-------|-------------------|');
    for (const [name, count] of sortedTools) {
      const qs = [...new Set(toolQuestions[name])].sort().join(', ');
      w(`| ${name} | ${count} | ${qs} |`);
    }
    w('');

    // --- MCP adoption detail ---
    const gm = metrics[runs.indexOf(grafemaRun)];
    const mcpAnswers = grafemaRun.answers.filter(a => !a.error && (a.mcp_calls || 0) > 0);
    const avgMcpPerQ = mcpAnswers.length > 0
      ? (mcpAnswers.reduce((s, a) => s + a.mcp_calls, 0) / mcpAnswers.length).toFixed(1)
      : '0';

    w('## MCP Adoption');
    w(`- Questions where MCP was used: ${gm.mcpQuestions}/${gm.validCount} (${pct(gm.mcpAdoption)})`);
    w(`- Questions where MCP was NOT used: ${gm.validCount - gm.mcpQuestions}/${gm.validCount}`);
    w(`- Avg MCP calls per question (when used): ${avgMcpPerQ}`);
    w('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv);
  const questions = loadQuestions(args.questions);
  const runs = args.runs.map(loadRunData);

  const report = generateReport(runs, questions);
  // Output to stdout so it can be redirected to a file
  console.log(report);
}

main();
