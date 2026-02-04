import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';

import { createTestDatabase } from '../helpers/TestRFDB.js';
import { setupSemanticTest } from '../helpers/setupSemanticTest.js';

const TEST_LABEL = 'reg327-local-vars';

/**
 * Helper to create a test project with given files
 */
async function setupTest(backend, files) {
  return setupSemanticTest(backend, files, { testLabel: TEST_LABEL });
}

describe('REG-327: Function-local variables in Express handlers', () => {
  let db;
  let backend;

  beforeEach(async () => {
    if (db) await db.cleanup();
    db = await createTestDatabase();
    backend = db.backend;
  });

  after(async () => {
    if (db) await db.cleanup();
  });

  it('should create VARIABLE node for local variable in Express handler', async () => {
    await setupTest(backend, {
      'index.js': `
const express = require('express');
const app = express();

app.get('/users', async (req, res) => {
  const users = await db.all('SELECT * FROM users');
  res.json(users);
});
      `
    });

    const allNodes = await backend.getAllNodes();

    // Collect all nodes
    const allNodesList = [];
    for await (const n of allNodes) {
      allNodesList.push(n);
    }
    console.log('Total nodes:', allNodesList.length);
    console.log('Node types:', [...new Set(allNodesList.map(n => n.type))].join(', '));

    // Debug: show all VARIABLE/CONSTANT nodes
    const varNodes = allNodesList.filter(n => n.type === 'VARIABLE' || n.type === 'CONSTANT');
    console.log('All VARIABLE/CONSTANT nodes:');
    varNodes.forEach(n => console.log(`  ${n.type}: ${n.name} (id: ${n.id})`));

    const usersVar = varNodes.find(n => n.name === 'users');
    assert.ok(usersVar, 'Variable "users" should be in the graph');
    assert.ok(
      usersVar.id.includes('anonymous[0]'),
      `users should have function scope in ID. Got: ${usersVar.id}`
    );
  });

  it('should create ASSIGNED_FROM edge from local variable to its initializer (call)', async () => {
    await setupTest(backend, {
      'index.js': `
const express = require('express');
const app = express();

app.get('/users', async (req, res) => {
  const users = await db.all('SELECT * FROM users');
  res.json(users);
});
      `
    });

    // Get all edges
    const edgesList = await backend.getAllEdges();

    console.log('All edges:');
    edgesList.forEach(e => console.log(`  ${e.type}: ${e.src} -> ${e.dst}`));

    // Find ASSIGNED_FROM edge for 'users' variable
    const assignedFromEdges = edgesList.filter(e => e.type === 'ASSIGNED_FROM');
    console.log('ASSIGNED_FROM edges:');
    assignedFromEdges.forEach(e => console.log(`  ${e.src} -> ${e.dst}`));

    const usersAssignment = assignedFromEdges.find(e =>
      e.src && e.src.includes('users')
    );

    assert.ok(
      usersAssignment,
      'ASSIGNED_FROM edge should exist for "users" variable pointing to db.all() call'
    );
    assert.ok(
      usersAssignment.dst && usersAssignment.dst.includes('db.all'),
      `ASSIGNED_FROM should point to db.all() call. Got: ${usersAssignment?.dst}`
    );
  });
});
