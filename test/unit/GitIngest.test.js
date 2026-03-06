/**
 * Tests for Git Graph Integration (REG-628)
 *
 * Tests parseGitLog, normalizeAuthors, GitIngest, YAML loading, and query functions.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import {
  parseGitLog,
  normalizeAuthors,
  GitIngest,
  KnowledgeBase,
  parseYamlArrayFile,
  getChurn,
  getCoChanges,
  getOwnership,
  getArchaeology,
} from '@grafema/util';

// Minimal YAML serializer for test fixtures (arrays of plain objects).
// Uses JSON-in-YAML style for nested arrays/objects to keep it simple.
function stringifyYaml(data) {
  if (Array.isArray(data)) {
    return data.map(item => {
      const lines = [];
      for (const [key, value] of Object.entries(item)) {
        if (Array.isArray(value)) {
          lines.push(`  ${key}: ${JSON.stringify(value)}`);
        } else if (typeof value === 'object' && value !== null) {
          lines.push(`  ${key}: ${JSON.stringify(value)}`);
        } else if (typeof value === 'string') {
          // Quote strings that could be ambiguous in YAML
          lines.push(`  ${key}: "${value.replace(/"/g, '\\"')}"`);
        } else {
          lines.push(`  ${key}: ${value}`);
        }
      }
      return '- ' + lines[0].trimStart() + '\n' + lines.slice(1).join('\n');
    }).join('\n') + '\n';
  }
  // For plain object (meta.yaml)
  const lines = [];
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === 'string') {
      lines.push(`${key}: "${value.replace(/"/g, '\\"')}"`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  return lines.join('\n') + '\n';
}

// =====================================================================
// parseGitLog
// =====================================================================

describe('parseGitLog', () => {
  it('parses standard git log --numstat output', () => {
    const raw = [
      'COMMIT_START',
      'abc123def456789',
      'feat: add login page',
      'John Doe',
      'john@example.com',
      '2026-01-15T10:30:00+00:00',
      '10\t2\tsrc/login.ts',
      '5\t0\tsrc/styles.css',
      '',
      'COMMIT_START',
      'def456abc789012',
      'fix: typo in header',
      'Jane Smith',
      'jane@example.com',
      '2026-01-14T09:00:00+00:00',
      '1\t1\tsrc/header.ts',
      '',
    ].join('\n');

    const commits = parseGitLog(raw);

    assert.equal(commits.length, 2);

    assert.equal(commits[0].hash, 'abc123def456789');
    assert.equal(commits[0].message, 'feat: add login page');
    assert.equal(commits[0].authorName, 'John Doe');
    assert.equal(commits[0].authorEmail, 'john@example.com');
    assert.equal(commits[0].date, '2026-01-15T10:30:00+00:00');
    assert.equal(commits[0].files.length, 2);
    assert.deepEqual(commits[0].files[0], { path: 'src/login.ts', added: 10, removed: 2 });
    assert.deepEqual(commits[0].files[1], { path: 'src/styles.css', added: 5, removed: 0 });

    assert.equal(commits[1].hash, 'def456abc789012');
    assert.equal(commits[1].files.length, 1);
  });

  it('handles binary files (- - path)', () => {
    const raw = [
      'COMMIT_START',
      'aaa111',
      'add image',
      'Dev',
      'dev@test.com',
      '2026-02-01T00:00:00Z',
      '-\t-\tassets/logo.png',
      '3\t1\tREADME.md',
      '',
    ].join('\n');

    const commits = parseGitLog(raw);
    assert.equal(commits.length, 1);
    assert.equal(commits[0].files.length, 2);
    assert.deepEqual(commits[0].files[0], { path: 'assets/logo.png', added: 0, removed: 0 });
    assert.deepEqual(commits[0].files[1], { path: 'README.md', added: 3, removed: 1 });
  });

  it('handles renamed files with {old => new} syntax', () => {
    const raw = [
      'COMMIT_START',
      'bbb222',
      'rename file',
      'Dev',
      'dev@test.com',
      '2026-02-01T00:00:00Z',
      '0\t0\tsrc/{old-name.ts => new-name.ts}',
      '',
    ].join('\n');

    const commits = parseGitLog(raw);
    assert.equal(commits[0].files[0].path, 'src/new-name.ts');
  });

  it('returns empty array for empty input', () => {
    assert.deepEqual(parseGitLog(''), []);
    assert.deepEqual(parseGitLog('\n\n'), []);
  });
});

// =====================================================================
// normalizeAuthors
// =====================================================================

describe('normalizeAuthors', () => {
  it('deduplicates by email, picks most-used name', () => {
    const commits = [
      { hash: '1', message: 'a', authorName: 'John Doe', authorEmail: 'john@example.com', date: '2026-01-01', files: [] },
      { hash: '2', message: 'b', authorName: 'John Doe', authorEmail: 'john@example.com', date: '2026-01-02', files: [] },
      { hash: '3', message: 'c', authorName: 'Johnny Doe', authorEmail: 'john@example.com', date: '2026-01-03', files: [] },
    ];

    const authors = normalizeAuthors(commits);
    assert.equal(authors.size, 1);

    const author = Array.from(authors.values())[0];
    assert.equal(author.name, 'John Doe'); // used 2x vs 1x
    assert.deepEqual(author.aliases, ['Johnny Doe']);
    assert.equal(author.type, 'AUTHOR');
    assert.ok(author.projections.includes('temporal'));
  });

  it('creates separate entries for different emails', () => {
    const commits = [
      { hash: '1', message: 'a', authorName: 'Alice', authorEmail: 'alice@a.com', date: '2026-01-01', files: [] },
      { hash: '2', message: 'b', authorName: 'Bob', authorEmail: 'bob@b.com', date: '2026-01-02', files: [] },
    ];

    const authors = normalizeAuthors(commits);
    assert.equal(authors.size, 2);
  });

  it('handles case-insensitive email matching', () => {
    const commits = [
      { hash: '1', message: 'a', authorName: 'Alice', authorEmail: 'Alice@Example.COM', date: '2026-01-01', files: [] },
      { hash: '2', message: 'b', authorName: 'Alice', authorEmail: 'alice@example.com', date: '2026-01-02', files: [] },
    ];

    const authors = normalizeAuthors(commits);
    assert.equal(authors.size, 1);
  });
});

// =====================================================================
// GitIngest — YAML write/read round-trip
// =====================================================================

describe('GitIngest', () => {
  let testDir;
  let repoDir;
  let knowledgeDir;

  before(() => {
    testDir = join(tmpdir(), `grafema-git-ingest-test-${Date.now()}`);
    repoDir = join(testDir, 'repo');
    knowledgeDir = join(testDir, 'knowledge');
    mkdirSync(repoDir, { recursive: true });

    // Create a test git repo with some commits
    execSync('git init', { cwd: repoDir });
    execSync('git config user.email "alice@test.com"', { cwd: repoDir });
    execSync('git config user.name "Alice"', { cwd: repoDir });

    writeFileSync(join(repoDir, 'file1.txt'), 'hello\n');
    execSync('git add .', { cwd: repoDir });
    execSync('git commit -m "initial commit"', { cwd: repoDir });

    writeFileSync(join(repoDir, 'file1.txt'), 'hello\nworld\n');
    writeFileSync(join(repoDir, 'file2.txt'), 'foo\n');
    execSync('git add .', { cwd: repoDir });
    execSync('git commit -m "add file2 and update file1"', { cwd: repoDir });

    // Second author
    execSync('git config user.email "bob@test.com"', { cwd: repoDir });
    execSync('git config user.name "Bob"', { cwd: repoDir });

    writeFileSync(join(repoDir, 'file2.txt'), 'bar\n');
    execSync('git add .', { cwd: repoDir });
    execSync('git commit -m "update file2"', { cwd: repoDir });
  });

  after(() => {
    if (testDir && existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    // Clean knowledge dir between tests
    if (existsSync(knowledgeDir)) {
      rmSync(knowledgeDir, { recursive: true, force: true });
    }
  });

  it('full ingest writes YAML files', async () => {
    const ingest = new GitIngest(knowledgeDir);
    const result = await ingest.ingestFull(repoDir);

    assert.equal(result.commits, 3);
    assert.equal(result.authors, 2);
    assert.ok(result.filesChanged > 0);

    // Verify authors.yaml exists
    const authorsPath = join(knowledgeDir, 'derived', 'authors.yaml');
    assert.ok(existsSync(authorsPath), 'authors.yaml should exist');

    // Verify meta.yaml exists
    const metaPath = join(knowledgeDir, 'derived', 'meta.yaml');
    assert.ok(existsSync(metaPath), 'meta.yaml should exist');

    // Verify commits directory exists with at least one YAML file
    const commitsDir = join(knowledgeDir, 'derived', 'commits');
    assert.ok(existsSync(commitsDir), 'commits/ directory should exist');
  });

  it('incremental ingest picks up new commits', async () => {
    const ingest = new GitIngest(knowledgeDir);

    // Full ingest first
    const result1 = await ingest.ingestFull(repoDir);
    assert.equal(result1.commits, 3);

    // Add a new commit
    execSync('git config user.email "alice@test.com"', { cwd: repoDir });
    execSync('git config user.name "Alice"', { cwd: repoDir });
    writeFileSync(join(repoDir, 'file3.txt'), 'new\n');
    execSync('git add .', { cwd: repoDir });
    execSync('git commit -m "add file3"', { cwd: repoDir });

    // Incremental ingest
    const result2 = await ingest.ingestIncremental(repoDir);
    assert.equal(result2.commits, 1, 'Should only pick up the new commit');

    // Clean up the extra commit for other tests
    execSync('git reset --hard HEAD~1', { cwd: repoDir });
  });

  it('incremental ingest without meta falls back to full', async () => {
    const ingest = new GitIngest(knowledgeDir);
    const result = await ingest.ingestIncremental(repoDir);
    assert.equal(result.commits, 3, 'Without meta, should do full ingest');
  });

  it('handles empty repo gracefully', async () => {
    const emptyDir = join(testDir, 'empty-repo');
    mkdirSync(emptyDir, { recursive: true });
    execSync('git init', { cwd: emptyDir });

    const emptyKnowledge = join(testDir, 'empty-knowledge');
    const ingest = new GitIngest(emptyKnowledge);
    const result = await ingest.ingestFull(emptyDir);

    assert.equal(result.commits, 0);
    assert.equal(result.authors, 0);
  });
});

// =====================================================================
// parseYamlArrayFile
// =====================================================================

describe('parseYamlArrayFile', () => {
  let testDir;

  before(() => {
    testDir = join(tmpdir(), `grafema-yaml-parse-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  after(() => {
    if (testDir && existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('parses COMMIT entries with hash-based IDs', () => {
    const data = [
      { type: 'COMMIT', hash: 'abc123def456', message: 'test', author_ref: 'alice', date: '2026-01-15T10:00:00Z', files: [], projections: ['temporal'] },
    ];
    const filePath = join(testDir, 'commits.yaml');
    writeFileSync(filePath, stringifyYaml(data));

    const nodes = parseYamlArrayFile(filePath);
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0].id, 'kb:commit:abc123de');
    assert.equal(nodes[0].type, 'COMMIT');
    assert.equal(nodes[0].lifecycle, 'derived');
    assert.equal(nodes[0].created, '2026-01-15');
    // Raw fields should be accessible
    assert.equal(/** @type {any} */ (nodes[0]).hash, 'abc123def456');
  });

  it('parses AUTHOR entries with slug-based IDs', () => {
    const data = [
      { type: 'AUTHOR', id: 'alice-smith', name: 'Alice Smith', emails: ['alice@test.com'], aliases: [], projections: ['organizational'] },
    ];
    const filePath = join(testDir, 'authors.yaml');
    writeFileSync(filePath, stringifyYaml(data));

    const nodes = parseYamlArrayFile(filePath);
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0].id, 'kb:author:alice-smith');
    assert.equal(nodes[0].type, 'AUTHOR');
  });

  it('throws on non-array YAML', () => {
    const filePath = join(testDir, 'bad.yaml');
    writeFileSync(filePath, 'key: value\n');
    assert.throws(() => parseYamlArrayFile(filePath), /must contain an array/);
  });

  it('throws on invalid type', () => {
    const data = [{ type: 'INVALID_TYPE' }];
    const filePath = join(testDir, 'bad-type.yaml');
    writeFileSync(filePath, stringifyYaml(data));
    assert.throws(() => parseYamlArrayFile(filePath), /Invalid or missing type/);
  });
});

// =====================================================================
// KnowledgeBase.load() integration with YAML array files
// =====================================================================

describe('KnowledgeBase YAML integration', () => {
  let testDir;
  let knowledgeDir;

  before(() => {
    testDir = join(tmpdir(), `grafema-kb-yaml-test-${Date.now()}`);
    knowledgeDir = join(testDir, 'knowledge');
    const derivedDir = join(knowledgeDir, 'derived');
    const commitsDir = join(derivedDir, 'commits');
    mkdirSync(commitsDir, { recursive: true });

    // Write test authors
    const authors = [
      { type: 'AUTHOR', id: 'alice', name: 'Alice', emails: ['alice@test.com'], aliases: [], projections: ['organizational'] },
      { type: 'AUTHOR', id: 'bob', name: 'Bob', emails: ['bob@test.com'], aliases: [], projections: ['organizational'] },
    ];
    writeFileSync(join(derivedDir, 'authors.yaml'), stringifyYaml(authors));

    // Write test commits
    const commits = [
      {
        type: 'COMMIT', hash: 'aaa11111', message: 'first', author_ref: 'alice',
        date: '2026-01-10T10:00:00Z', files: [{ path: 'src/a.ts', added: 10, removed: 0 }],
        projections: ['temporal'],
      },
      {
        type: 'COMMIT', hash: 'bbb22222', message: 'second', author_ref: 'alice',
        date: '2026-01-15T10:00:00Z',
        files: [{ path: 'src/a.ts', added: 5, removed: 2 }, { path: 'src/b.ts', added: 20, removed: 0 }],
        projections: ['temporal'],
      },
      {
        type: 'COMMIT', hash: 'ccc33333', message: 'third', author_ref: 'bob',
        date: '2026-02-01T10:00:00Z',
        files: [{ path: 'src/b.ts', added: 3, removed: 1 }],
        projections: ['temporal'],
      },
    ];
    writeFileSync(join(commitsDir, '2026-01.yaml'), stringifyYaml(commits.slice(0, 2)));
    writeFileSync(join(commitsDir, '2026-02.yaml'), stringifyYaml(commits.slice(2)));

    // Write meta.yaml (should be skipped by loader)
    writeFileSync(join(derivedDir, 'meta.yaml'), stringifyYaml({ last_commit: 'ccc33333', last_ingest: '2026-02-01', branch: 'HEAD' }));
  });

  after(() => {
    if (testDir && existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('loads YAML derived nodes into the KB index', async () => {
    const kb = new KnowledgeBase(knowledgeDir);
    await kb.load();

    const stats = await kb.getStats();
    assert.equal(stats.totalNodes, 5, 'Should have 2 authors + 3 commits');
    assert.equal(stats.byType['AUTHOR'], 2);
    assert.equal(stats.byType['COMMIT'], 3);
    assert.equal(stats.byLifecycle['derived'], 5);
  });

  it('nodes are accessible by ID', async () => {
    const kb = new KnowledgeBase(knowledgeDir);
    await kb.load();

    const alice = kb.getNode('kb:author:alice');
    assert.ok(alice, 'Alice should be in the KB');
    assert.equal(alice.type, 'AUTHOR');
    assert.equal(/** @type {any} */ (alice).name, 'Alice');

    const commit = kb.getNode('kb:commit:aaa11111');
    assert.ok(commit, 'Commit should be in the KB');
    assert.equal(commit.type, 'COMMIT');
  });

  it('queryNodes filters by type', async () => {
    const kb = new KnowledgeBase(knowledgeDir);
    await kb.load();

    const commits = await kb.queryNodes({ type: 'COMMIT' });
    assert.equal(commits.length, 3);

    const authors = await kb.queryNodes({ type: 'AUTHOR' });
    assert.equal(authors.length, 2);
  });
});

// =====================================================================
// Git Query Functions
// =====================================================================

describe('getChurn', () => {
  let kb;

  before(async () => {
    const testDir = join(tmpdir(), `grafema-churn-test-${Date.now()}`);
    const knowledgeDir = join(testDir, 'knowledge');
    const derivedDir = join(knowledgeDir, 'derived');
    const commitsDir = join(derivedDir, 'commits');
    mkdirSync(commitsDir, { recursive: true });

    const commits = [
      {
        type: 'COMMIT', hash: 'aaa11111', message: 'first', author_ref: 'alice',
        date: '2026-01-10T10:00:00Z',
        files: [{ path: 'src/hot.ts', added: 10, removed: 0 }, { path: 'src/cold.ts', added: 5, removed: 0 }],
        projections: ['temporal'],
      },
      {
        type: 'COMMIT', hash: 'bbb22222', message: 'second', author_ref: 'alice',
        date: '2026-01-20T10:00:00Z',
        files: [{ path: 'src/hot.ts', added: 3, removed: 1 }],
        projections: ['temporal'],
      },
      {
        type: 'COMMIT', hash: 'ccc33333', message: 'third', author_ref: 'bob',
        date: '2026-02-01T10:00:00Z',
        files: [{ path: 'src/hot.ts', added: 1, removed: 1 }],
        projections: ['temporal'],
      },
    ];
    writeFileSync(join(commitsDir, '2026-01.yaml'), stringifyYaml(commits.slice(0, 2)));
    writeFileSync(join(commitsDir, '2026-02.yaml'), stringifyYaml(commits.slice(2)));

    kb = new KnowledgeBase(knowledgeDir);
    await kb.load();
  });

  it('ranks files by change frequency', async () => {
    const entries = await getChurn(kb);

    assert.ok(entries.length >= 2);
    assert.equal(entries[0].path, 'src/hot.ts');
    assert.equal(entries[0].changeCount, 3);
    assert.equal(entries[0].totalAdded, 14);
    assert.equal(entries[0].totalRemoved, 2);

    assert.equal(entries[1].path, 'src/cold.ts');
    assert.equal(entries[1].changeCount, 1);
  });

  it('respects limit option', async () => {
    const entries = await getChurn(kb, { limit: 1 });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].path, 'src/hot.ts');
  });

  it('filters by since date', async () => {
    const entries = await getChurn(kb, { since: '2026-02-01' });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].path, 'src/hot.ts');
    assert.equal(entries[0].changeCount, 1);
  });
});

describe('getCoChanges', () => {
  let kb;

  before(async () => {
    const testDir = join(tmpdir(), `grafema-cochange-test-${Date.now()}`);
    const knowledgeDir = join(testDir, 'knowledge');
    const derivedDir = join(knowledgeDir, 'derived');
    const commitsDir = join(derivedDir, 'commits');
    mkdirSync(commitsDir, { recursive: true });

    const commits = [
      {
        type: 'COMMIT', hash: 'aaa', message: 'a', author_ref: 'dev', date: '2026-01-01T00:00:00Z',
        files: [{ path: 'a.ts', added: 1, removed: 0 }, { path: 'b.ts', added: 1, removed: 0 }],
        projections: ['temporal'],
      },
      {
        type: 'COMMIT', hash: 'bbb', message: 'b', author_ref: 'dev', date: '2026-01-02T00:00:00Z',
        files: [{ path: 'a.ts', added: 1, removed: 0 }, { path: 'b.ts', added: 1, removed: 0 }, { path: 'c.ts', added: 1, removed: 0 }],
        projections: ['temporal'],
      },
      {
        type: 'COMMIT', hash: 'ccc', message: 'c', author_ref: 'dev', date: '2026-01-03T00:00:00Z',
        files: [{ path: 'a.ts', added: 1, removed: 0 }],
        projections: ['temporal'],
      },
    ];
    writeFileSync(join(commitsDir, '2026-01.yaml'), stringifyYaml(commits));

    kb = new KnowledgeBase(knowledgeDir);
    await kb.load();
  });

  it('detects files that always change together', async () => {
    const entries = await getCoChanges(kb, 'a.ts', { minSupport: 0 });

    // a.ts appears in 3 commits, b.ts co-occurs in 2
    const bEntry = entries.find(e => e.path === 'b.ts');
    assert.ok(bEntry, 'b.ts should be a co-change');
    assert.equal(bEntry.coChangeCount, 2);
    assert.ok(Math.abs(bEntry.support - 2/3) < 0.01);
  });

  it('filters by minSupport', async () => {
    const entries = await getCoChanges(kb, 'a.ts', { minSupport: 0.5 });

    // b.ts has 2/3 support, c.ts has 1/3 support
    assert.ok(entries.some(e => e.path === 'b.ts'));
    assert.ok(!entries.some(e => e.path === 'c.ts'));
  });

  it('returns empty for unknown file', async () => {
    const entries = await getCoChanges(kb, 'nonexistent.ts');
    assert.equal(entries.length, 0);
  });
});

describe('getOwnership', () => {
  let kb;

  before(async () => {
    const testDir = join(tmpdir(), `grafema-ownership-test-${Date.now()}`);
    const knowledgeDir = join(testDir, 'knowledge');
    const derivedDir = join(knowledgeDir, 'derived');
    const commitsDir = join(derivedDir, 'commits');
    mkdirSync(commitsDir, { recursive: true });

    const authors = [
      { type: 'AUTHOR', id: 'alice', name: 'Alice', emails: ['alice@test.com'], aliases: [], projections: [] },
      { type: 'AUTHOR', id: 'bob', name: 'Bob', emails: ['bob@test.com'], aliases: [], projections: [] },
    ];
    writeFileSync(join(derivedDir, 'authors.yaml'), stringifyYaml(authors));

    const commits = [
      {
        type: 'COMMIT', hash: 'aaa', message: 'a', author_ref: 'kb:author:alice', date: '2026-01-01T00:00:00Z',
        files: [{ path: 'shared.ts', added: 20, removed: 0 }],
        projections: ['temporal'],
      },
      {
        type: 'COMMIT', hash: 'bbb', message: 'b', author_ref: 'kb:author:alice', date: '2026-01-02T00:00:00Z',
        files: [{ path: 'shared.ts', added: 5, removed: 2 }],
        projections: ['temporal'],
      },
      {
        type: 'COMMIT', hash: 'ccc', message: 'c', author_ref: 'kb:author:bob', date: '2026-01-03T00:00:00Z',
        files: [{ path: 'shared.ts', added: 3, removed: 1 }],
        projections: ['temporal'],
      },
    ];
    writeFileSync(join(commitsDir, '2026-01.yaml'), stringifyYaml(commits));

    kb = new KnowledgeBase(knowledgeDir);
    await kb.load();
  });

  it('ranks authors by commit count', async () => {
    const entries = await getOwnership(kb, 'shared.ts');

    assert.equal(entries.length, 2);
    assert.equal(entries[0].authorId, 'kb:author:alice');
    assert.equal(entries[0].commits, 2);
    assert.equal(entries[0].linesAdded, 25);
    assert.equal(entries[0].linesRemoved, 2);

    assert.equal(entries[1].authorId, 'kb:author:bob');
    assert.equal(entries[1].commits, 1);
  });

  it('returns empty for file with no commits', async () => {
    const entries = await getOwnership(kb, 'unknown.ts');
    assert.equal(entries.length, 0);
  });
});

describe('getArchaeology', () => {
  let kb;

  before(async () => {
    const testDir = join(tmpdir(), `grafema-archaeology-test-${Date.now()}`);
    const knowledgeDir = join(testDir, 'knowledge');
    const derivedDir = join(knowledgeDir, 'derived');
    const commitsDir = join(derivedDir, 'commits');
    mkdirSync(commitsDir, { recursive: true });

    const commits = [
      {
        type: 'COMMIT', hash: 'first111', message: 'create', author_ref: 'alice', date: '2025-06-01T10:00:00Z',
        files: [{ path: 'legacy.ts', added: 100, removed: 0 }],
        projections: ['temporal'],
      },
      {
        type: 'COMMIT', hash: 'last2222', message: 'update', author_ref: 'bob', date: '2026-02-15T10:00:00Z',
        files: [{ path: 'legacy.ts', added: 5, removed: 3 }],
        projections: ['temporal'],
      },
    ];
    writeFileSync(join(commitsDir, 'mixed.yaml'), stringifyYaml(commits));

    kb = new KnowledgeBase(knowledgeDir);
    await kb.load();
  });

  it('returns first and last commit info', async () => {
    const entry = await getArchaeology(kb, 'legacy.ts');

    assert.equal(entry.path, 'legacy.ts');
    assert.equal(entry.firstCommitDate, '2025-06-01T10:00:00Z');
    assert.equal(entry.firstAuthor, 'alice');
    assert.equal(entry.lastCommitHash, 'last2222');
    assert.equal(entry.lastCommitDate, '2026-02-15T10:00:00Z');
    assert.equal(entry.lastAuthor, 'bob');
  });

  it('returns empty strings for unknown file', async () => {
    const entry = await getArchaeology(kb, 'nonexistent.ts');
    assert.equal(entry.lastCommitHash, '');
    assert.equal(entry.firstCommitDate, '');
  });
});

// =====================================================================
// End-to-end: GitIngest → KnowledgeBase → queries
// =====================================================================

describe('GitIngest → KnowledgeBase → query round-trip', () => {
  let testDir;
  let repoDir;
  let knowledgeDir;

  before(() => {
    testDir = join(tmpdir(), `grafema-e2e-test-${Date.now()}`);
    repoDir = join(testDir, 'repo');
    knowledgeDir = join(testDir, 'knowledge');
    mkdirSync(repoDir, { recursive: true });

    // Create test repo with 2 authors
    execSync('git init', { cwd: repoDir });
    execSync('git config user.email "alice@test.com"', { cwd: repoDir });
    execSync('git config user.name "Alice"', { cwd: repoDir });

    writeFileSync(join(repoDir, 'app.ts'), 'const x = 1;\n');
    writeFileSync(join(repoDir, 'util.ts'), 'export {};\n');
    execSync('git add .', { cwd: repoDir });
    execSync('git commit -m "init"', { cwd: repoDir });

    execSync('git config user.email "bob@test.com"', { cwd: repoDir });
    execSync('git config user.name "Bob"', { cwd: repoDir });

    writeFileSync(join(repoDir, 'app.ts'), 'const x = 2;\n');
    execSync('git add .', { cwd: repoDir });
    execSync('git commit -m "update app"', { cwd: repoDir });
  });

  after(() => {
    if (testDir && existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('ownership query resolves author names after full round-trip', async () => {
    // Ingest
    const ingest = new GitIngest(knowledgeDir);
    await ingest.ingestFull(repoDir);

    // Load into KB
    const kb = new KnowledgeBase(knowledgeDir);
    await kb.load();

    // Verify author_ref in commits matches KB author IDs
    const commits = await kb.queryNodes({ type: 'COMMIT' });
    const authors = await kb.queryNodes({ type: 'AUTHOR' });

    assert.ok(commits.length >= 2, 'Should have at least 2 commits');
    assert.ok(authors.length >= 2, 'Should have at least 2 authors');

    // The critical check: author_ref in commits must start with kb:author:
    for (const commit of commits) {
      const ref = /** @type {any} */ (commit).author_ref;
      assert.ok(ref.startsWith('kb:author:'), `author_ref "${ref}" should start with "kb:author:"`);
    }

    // Ownership query should resolve author names
    const ownership = await getOwnership(kb, 'app.ts');
    assert.ok(ownership.length >= 1, 'Should have at least 1 owner for app.ts');

    // Author name should be resolved, not just the ID
    for (const entry of ownership) {
      assert.ok(entry.authorName, `authorName should be resolved for ${entry.authorId}`);
      assert.notEqual(entry.authorName, entry.authorId, 'authorName should differ from authorId');
    }
  });
});
