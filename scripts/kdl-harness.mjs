/**
 * KDL Harness — Knowledge Data Layer auto-update pipeline.
 *
 * Watches local sources for changes, extracts knowledge, writes to RFDB.
 * Sources: Claude Code sessions, git commits, research docs, effects-db YAML.
 * Remote sources (Linear, GitHub PRs) polled on interval.
 *
 * Usage:
 *   node scripts/kdl-harness.mjs              # one-shot diff + extract
 *   node scripts/kdl-harness.mjs --watch      # continuous watcher
 *   node scripts/kdl-harness.mjs --source git # process only git source
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, appendFileSync } from 'fs';
import { join, basename, dirname } from 'path';
import { execSync } from 'child_process';
import { createHash } from 'crypto';

const PROJECT = process.cwd();
const STATE_FILE = join(PROJECT, '.grafema', 'kdl-state.json');
const KNOWLEDGE_LOG = join(PROJECT, '.grafema', 'kdl-findings.jsonl');
const SESSIONS_DIR = `${process.env.HOME}/.claude/projects`;
const MODEL = 'claude-haiku-4-5-20251001';

let API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  try {
    const match = readFileSync(`${process.env.HOME}/providers/keys.env`, 'utf-8').match(/ANTHROPIC=(.+)/);
    if (match) API_KEY = match[1].trim();
  } catch {}
}

const args = process.argv.slice(2);
const watchMode = args.includes('--watch');
const sourceFilter = args.includes('--source') ? args[args.indexOf('--source') + 1] : null;
const dryRun = args.includes('--dry-run');

function loadState() {
  if (existsSync(STATE_FILE)) {
    return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
  }
  return {
    sessions: { processed: {}, last_check: null },
    commits: { last_sha: null },
    prs: { last_number: 0 },
    linear: { last_updated: null },
    research: { hashes: {} },
    effects: { hashes: {} },
    graph: { last_node_count: 0, last_edge_count: 0 },
  };
}

function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function logFinding(finding) {
  appendFileSync(KNOWLEDGE_LOG, JSON.stringify(finding) + '\n');
}

function fileHash(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Source: Git commits
// ---------------------------------------------------------------------------

async function processGitCommits(state) {
  const lastSha = state.commits.last_sha;
  let range = lastSha ? `${lastSha}..HEAD` : '--max-count=20';

  let commits;
  try {
    const output = execSync(`git log ${range} --format="%H|%s|%an|%ai" --no-merges`, { encoding: 'utf-8' }).trim();
    if (!output) return [];
    commits = output.split('\n').map(line => {
      const [sha, subject, author, date] = line.split('|');
      return { sha, subject, author, date };
    });
  } catch { return []; }

  const findings = [];
  for (const commit of commits) {
    const sub = commit.subject.toLowerCase();

    let type = 'CHANGE';
    if (sub.startsWith('feat')) type = 'DECISION';
    else if (sub.startsWith('fix')) type = 'INCIDENT_FIX';
    else if (sub.startsWith('refactor')) type = 'REFACTOR';
    else if (sub.startsWith('perf')) type = 'OPTIMIZATION';
    else if (sub.startsWith('revert')) type = 'REVERT';
    else continue;

    let diffStats = '';
    try {
      diffStats = execSync(`git diff --stat ${commit.sha}^..${commit.sha} 2>/dev/null | tail -1`, { encoding: 'utf-8' }).trim();
    } catch {}

    findings.push({
      source: 'git',
      type,
      name: commit.subject,
      content: `Commit ${commit.sha.slice(0, 8)} by ${commit.author} on ${commit.date.slice(0, 10)}. ${diffStats}`,
      sha: commit.sha,
      date: commit.date,
    });
  }

  if (commits.length > 0) {
    state.commits.last_sha = commits[0].sha;
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Source: Research docs
// ---------------------------------------------------------------------------

async function processResearchDocs(state) {
  const researchDir = join(PROJECT, '_ai', 'research');
  if (!existsSync(researchDir)) return [];

  const files = readdirSync(researchDir).filter(f => f.endsWith('.md'));
  const findings = [];

  for (const file of files) {
    const path = join(researchDir, file);
    const hash = fileHash(path);
    const prevHash = state.research.hashes[file];

    if (hash === prevHash) continue;

    const isNew = !prevHash;
    const content = readFileSync(path, 'utf-8');
    const firstLine = content.split('\n').find(l => l.startsWith('# ')) || file;
    const title = firstLine.replace(/^#+\s*/, '');

    if (API_KEY && content.length > 200 && !dryRun) {
      try {
        const summary = await summarizeWithHaiku(content.slice(0, 8000), `Summarize this research document in 2-3 sentences. What architectural decision or concept does it formalize?`);
        findings.push({
          source: 'research',
          type: isNew ? 'NEW_RESEARCH' : 'UPDATED_RESEARCH',
          name: title,
          content: summary,
          file: `_ai/research/${file}`,
          date: new Date().toISOString(),
        });
      } catch (e) {
        console.error(`  Haiku error for ${file}: ${e.message}`);
      }
    } else {
      findings.push({
        source: 'research',
        type: isNew ? 'NEW_RESEARCH' : 'UPDATED_RESEARCH',
        name: title,
        content: `Research doc ${isNew ? 'created' : 'updated'}: ${file} (${content.length} chars)`,
        file: `_ai/research/${file}`,
        date: new Date().toISOString(),
      });
    }

    state.research.hashes[file] = hash;
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Source: Effects-DB YAML
// ---------------------------------------------------------------------------

async function processEffectsDb(state) {
  const effectsDirs = ['effects-db/packages', 'effects-db/runtimes'];
  const findings = [];

  for (const dir of effectsDirs) {
    const fullDir = join(PROJECT, dir);
    if (!existsSync(fullDir)) continue;

    for (const file of readdirSync(fullDir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))) {
      const path = join(fullDir, file);
      const hash = fileHash(path);
      const prevHash = (state.effects.hashes || {})[`${dir}/${file}`];

      if (hash === prevHash) continue;

      const isNew = !prevHash;
      findings.push({
        source: 'effects-db',
        type: isNew ? 'NEW_EFFECT' : 'UPDATED_EFFECT',
        name: `effects-db: ${file.replace(/\.(yaml|yml)$/, '')}`,
        content: `${isNew ? 'New' : 'Updated'} effects definition: ${dir}/${file}`,
        file: `${dir}/${file}`,
        date: new Date().toISOString(),
      });

      if (!state.effects.hashes) state.effects.hashes = {};
      state.effects.hashes[`${dir}/${file}`] = hash;
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Source: Claude Code sessions
// ---------------------------------------------------------------------------

async function processNewSessions(state) {
  const grafemaDirs = [];
  try {
    for (const d of readdirSync(SESSIONS_DIR)) {
      if (d.includes('grafema') && !d.includes('enox-smart-node')) {
        grafemaDirs.push(join(SESSIONS_DIR, d));
      }
    }
  } catch { return []; }

  const newSessions = [];
  for (const dir of grafemaDirs) {
    try {
      for (const f of readdirSync(dir).filter(f => f.endsWith('.jsonl'))) {
        const path = join(dir, f);
        const sid = f.replace('.jsonl', '');
        const stat = statSync(path);

        if (stat.size < 50000) continue;
        if (state.sessions.processed[sid]) continue;

        newSessions.push({ path, sid, size: stat.size, mtime: stat.mtimeMs });
      }
    } catch {}
  }

  if (newSessions.length === 0) return [];

  newSessions.sort((a, b) => b.mtime - a.mtime);
  console.log(`  ${newSessions.length} new sessions to process`);

  if (!API_KEY || dryRun) {
    console.log(`  ${!API_KEY ? 'No ANTHROPIC_API_KEY' : 'Dry-run'} — skipping session extraction (${newSessions.length} pending)`);
    return newSessions.map(s => ({
      source: 'session', type: 'PENDING_EXTRACTION',
      name: `Session ${s.sid.slice(0, 8)}`,
      content: `${(s.size / 1024).toFixed(0)}KB, needs Haiku extraction`,
      session_id: s.sid,
    }));
  }

  const findings = [];
  for (const session of newSessions.slice(0, 3)) {
    console.log(`  Extracting ${session.sid.slice(0, 8)}... (${(session.size / 1024).toFixed(0)}KB)`);

    try {
      const result = execSync(
        `EXTRACTION_OUTPUT=/dev/stdout node ${join(PROJECT, 'scripts/extract-session-knowledge.mjs')} "${session.path}" 2>/dev/null`,
        { encoding: 'utf-8', timeout: 300000 }
      ).trim();

      if (result) {
        for (const line of result.split('\n').filter(l => l.trim())) {
          try {
            const entity = JSON.parse(line);
            findings.push({
              source: 'session',
              ...entity,
              session_id: session.sid,
            });
          } catch {}
        }
      }
    } catch (e) {
      console.error(`  Error extracting ${session.sid.slice(0, 8)}: ${e.message?.slice(0, 80)}`);
    }

    state.sessions.processed[session.sid] = new Date().toISOString();
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Source: GitHub PRs (poll)
// ---------------------------------------------------------------------------

async function processNewPRs(state) {
  let prs;
  try {
    const output = execSync(
      `gh pr list --state merged --limit 10 --json number,title,mergedAt,body`,
      { encoding: 'utf-8', timeout: 15000 }
    );
    prs = JSON.parse(output);
  } catch { return []; }

  const findings = [];
  for (const pr of prs) {
    if (pr.number <= (state.prs.last_number || 0)) continue;

    const summary = (pr.body || '').split('\n')
      .filter(l => l.startsWith('- ') || l.startsWith('* '))
      .slice(0, 5)
      .join('; ') || pr.title;

    findings.push({
      source: 'github-pr',
      type: 'PR_MERGED',
      name: `PR#${pr.number}: ${pr.title}`,
      content: summary.slice(0, 500),
      date: pr.mergedAt,
      pr_number: pr.number,
    });
  }

  if (prs.length > 0) {
    state.prs.last_number = Math.max(state.prs.last_number || 0, ...prs.map(p => p.number));
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Haiku summarizer
// ---------------------------------------------------------------------------

async function summarizeWithHaiku(text, instruction) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 500,
      messages: [{ role: 'user', content: `${instruction}\n\n---\n${text}` }],
    }),
  });

  const data = await res.json();
  return data.content?.[0]?.text || '';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function runOnce() {
  const state = loadState();
  const allFindings = [];

  const sources = [
    { name: 'git', fn: () => processGitCommits(state) },
    { name: 'research', fn: () => processResearchDocs(state) },
    { name: 'effects', fn: () => processEffectsDb(state) },
    { name: 'sessions', fn: () => processNewSessions(state) },
    { name: 'prs', fn: () => processNewPRs(state) },
  ];

  for (const source of sources) {
    if (sourceFilter && source.name !== sourceFilter) continue;

    console.log(`[${source.name}]`);
    try {
      const findings = await source.fn();
      if (findings.length > 0) {
        console.log(`  ${findings.length} findings`);
        allFindings.push(...findings);
      } else {
        console.log(`  no changes`);
      }
    } catch (e) {
      console.error(`  error: ${e.message}`);
    }
  }

  if (allFindings.length > 0 && !dryRun) {
    for (const f of allFindings) {
      logFinding(f);
    }
    console.log(`\nTotal: ${allFindings.length} findings written to ${KNOWLEDGE_LOG}`);
  } else if (dryRun) {
    console.log(`\n[dry-run] ${allFindings.length} findings would be written`);
    for (const f of allFindings) {
      console.log(`  [${f.source}/${f.type}] ${f.name}`);
    }
  }

  state.sessions.last_check = new Date().toISOString();
  if (!dryRun) saveState(state);

  return allFindings;
}

async function main() {
  console.log('KDL Harness — Knowledge Data Layer');
  console.log(`Project: ${PROJECT}`);
  console.log(`State: ${STATE_FILE}`);
  console.log(`Mode: ${watchMode ? 'watch' : 'one-shot'}${sourceFilter ? ` (source: ${sourceFilter})` : ''}${dryRun ? ' [dry-run]' : ''}`);
  console.log();

  await runOnce();

  if (watchMode) {
    const POLL_INTERVAL = 30 * 60 * 1000;
    console.log(`\nWatching... (poll every ${POLL_INTERVAL / 60000} min)`);
    setInterval(runOnce, POLL_INTERVAL);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
