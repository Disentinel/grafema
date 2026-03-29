/**
 * MCP Knowledge Handler Tests (REG-629)
 *
 * End-to-end tests exercising MCP handler functions directly:
 * handleAddKnowledge, handleQueryKnowledge, handleQueryDecisions,
 * handleSupersedeFact, handleGetKnowledgeStats.
 *
 * Uses setProjectPath + resetKnowledgeBase to isolate each group
 * with a fresh KnowledgeBase in a temp directory.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  handleAddKnowledge,
  handleQueryKnowledge,
  handleQueryDecisions,
  handleSupersedeFact,
  handleGetKnowledgeStats,
} from '../../packages/mcp/dist/handlers/index.js';

import {
  setProjectPath,
  resetKnowledgeBase,
} from '../../packages/mcp/dist/state.js';

let testCounter = 0;

function freshTempDir() {
  const dir = join(tmpdir(), `grafema-kb-handler-${Date.now()}-${testCounter++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function setupHandlerEnv(dir) {
  setProjectPath(dir);
  resetKnowledgeBase();
}

describe('MCP Knowledge Handlers (REG-629)', () => {

  // --- handleAddKnowledge ---

  describe('handleAddKnowledge', () => {
    let dir;

    before(() => {
      dir = freshTempDir();
      setupHandlerEnv(dir);
    });

    after(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    it('should create a FACT with subtype, scope, confidence, projections', async () => {
      const result = await handleAddKnowledge({
        type: 'FACT',
        content: 'Redis is the session store.',
        slug: 'redis-session',
        subtype: 'domain',
        scope: 'module',
        confidence: 'high',
        projections: ['epistemic'],
      });

      assert.strictEqual(result.isError, undefined);
      const text = result.content[0].text;
      assert.ok(text.includes('FACT'), 'Result should mention FACT type');
      assert.ok(text.includes('kb:fact:redis-session'), 'Result should include node ID');
      assert.ok(text.includes('File:'), 'Result should show file path');
      assert.ok(text.includes('declared'), 'Result should show lifecycle');

      // Verify file on disk
      const kbDir = join(dir, 'knowledge');
      assert.ok(existsSync(kbDir), 'knowledge/ directory should exist');
    });

    it('should create a DECISION with subtype=adr, status=active, applies_to', async () => {
      const result = await handleAddKnowledge({
        type: 'DECISION',
        content: 'Use file-based storage for KB.',
        slug: 'kb-file-storage',
        subtype: 'adr',
        scope: 'global',
        status: 'active',
        applies_to: ['packages/util:KnowledgeBase:CLASS'],
      });

      assert.strictEqual(result.isError, undefined);
      const text = result.content[0].text;
      assert.ok(text.includes('DECISION'));
      assert.ok(text.includes('kb:decision:kb-file-storage'));
    });

    it('should create a SESSION with task_id (thin pointer)', async () => {
      const result = await handleAddKnowledge({
        type: 'SESSION',
        content: 'Implemented knowledge handlers.',
        slug: 'session-reg-629',
        task_id: 'REG-629',
      });

      assert.strictEqual(result.isError, undefined);
      const text = result.content[0].text;
      assert.ok(text.includes('SESSION'));
      assert.ok(text.includes('kb:session:session-reg-629'));
    });

    it('should return isError on slug collision', async () => {
      // 'redis-session' was already created above
      const result = await handleAddKnowledge({
        type: 'FACT',
        content: 'Duplicate slug.',
        slug: 'redis-session',
      });

      assert.strictEqual(result.isError, true);
      assert.ok(result.content[0].text.includes('Failed to add knowledge'));
    });
  });

  // --- handleQueryKnowledge ---

  describe('handleQueryKnowledge', () => {
    let dir;

    before(async () => {
      dir = freshTempDir();
      setupHandlerEnv(dir);

      // Seed: 2 facts + 1 decision
      await handleAddKnowledge({
        type: 'FACT',
        content: 'Auth uses bcrypt for hashing.',
        slug: 'auth-bcrypt',
        projections: ['epistemic'],
      });
      await handleAddKnowledge({
        type: 'FACT',
        content: 'Redis stores sessions.',
        slug: 'redis-sessions',
        projections: ['temporal'],
      });
      await handleAddKnowledge({
        type: 'DECISION',
        content: 'Migrate to argon2.',
        slug: 'migrate-argon2',
        status: 'active',
      });
    });

    after(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    it('should filter by type and return correct count', async () => {
      const result = await handleQueryKnowledge({ type: 'FACT' });
      const text = result.content[0].text;
      assert.ok(text.includes('Found 2 node(s)'), `Expected 2 FACTs, got: ${text}`);
    });

    it('should perform text search across nodes', async () => {
      const result = await handleQueryKnowledge({ text: 'bcrypt' });
      const text = result.content[0].text;
      assert.ok(text.includes('Found 1 node(s)'), `Expected 1 match, got: ${text}`);
      assert.ok(text.includes('auth-bcrypt'));
    });

    it('should return "No matching" for empty results', async () => {
      const result = await handleQueryKnowledge({ text: 'nonexistent-xyzzy' });
      const text = result.content[0].text;
      assert.ok(text.includes('No matching knowledge nodes found'));
    });
  });

  // --- handleQueryDecisions ---

  describe('handleQueryDecisions', () => {
    let dir;

    before(async () => {
      dir = freshTempDir();
      setupHandlerEnv(dir);

      await handleAddKnowledge({
        type: 'DECISION',
        content: 'Use REST for public API.',
        slug: 'rest-api',
        status: 'active',
      });
      await handleAddKnowledge({
        type: 'DECISION',
        content: 'Use SOAP for legacy.',
        slug: 'soap-legacy',
        status: 'superseded',
      });
    });

    after(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    it('should filter by status=active', async () => {
      const result = await handleQueryDecisions({ status: 'active' });
      const text = result.content[0].text;
      assert.ok(text.includes('Found 1 decision(s)'), `Expected 1, got: ${text}`);
      assert.ok(text.includes('rest-api'));
    });

    it('should return all decisions when no filter', async () => {
      const result = await handleQueryDecisions({});
      const text = result.content[0].text;
      assert.ok(text.includes('Found 2 decision(s)'), `Expected 2, got: ${text}`);
    });
  });

  // --- handleSupersedeFact ---

  describe('handleSupersedeFact', () => {
    let dir;

    before(async () => {
      dir = freshTempDir();
      setupHandlerEnv(dir);

      await handleAddKnowledge({
        type: 'FACT',
        content: 'Old auth fact.',
        slug: 'old-auth',
        confidence: 'medium',
      });
    });

    after(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    it('should supersede and show old/new IDs', async () => {
      const result = await handleSupersedeFact({
        old_id: 'kb:fact:old-auth',
        new_content: 'Updated auth fact with argon2.',
        new_slug: 'new-auth',
      });

      assert.strictEqual(result.isError, undefined);
      const text = result.content[0].text;
      assert.ok(text.includes('kb:fact:old-auth'), 'Should reference old ID');
      assert.ok(text.includes('kb:fact:new-auth'), 'Should reference new ID');
      assert.ok(text.includes('Superseded fact'));
    });

    it('should return isError for non-existent fact', async () => {
      const result = await handleSupersedeFact({
        old_id: 'kb:fact:does-not-exist',
        new_content: 'Whatever.',
      });

      assert.strictEqual(result.isError, true);
      assert.ok(result.content[0].text.includes('Failed to supersede'));
    });
  });

  // --- handleGetKnowledgeStats ---

  describe('handleGetKnowledgeStats', () => {
    let dir;

    before(async () => {
      dir = freshTempDir();
      setupHandlerEnv(dir);

      await handleAddKnowledge({
        type: 'FACT',
        content: 'Stats fact one.',
        slug: 'stats-fact-1',
      });
      await handleAddKnowledge({
        type: 'FACT',
        content: 'Stats fact two.',
        slug: 'stats-fact-2',
      });
      await handleAddKnowledge({
        type: 'DECISION',
        content: 'Stats decision.',
        slug: 'stats-decision',
        status: 'active',
      });
    });

    after(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    it('should show correct counts after adding nodes', async () => {
      const result = await handleGetKnowledgeStats();

      assert.strictEqual(result.isError, undefined);
      const text = result.content[0].text;
      assert.ok(text.includes('Total nodes: 3'), `Expected 3 total, got: ${text}`);
      assert.ok(text.includes('FACT: 2'), `Expected FACT: 2, got: ${text}`);
      assert.ok(text.includes('DECISION: 1'), `Expected DECISION: 1, got: ${text}`);
    });
  });
});
