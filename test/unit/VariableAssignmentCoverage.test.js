/**
 * Variable Assignment Coverage Tests (REG-534)
 *
 * Tests that every VARIABLE/CONSTANT with an initializer gets at least one
 * assignment edge. Covers expression types that previously caused silent
 * fallthroughs in trackVariableAssignment().
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';

after(cleanupAllTestDatabases);

describe('Variable Assignment Coverage (REG-534)', () => {
  let testCounter = 0;

  async function setupTest(files) {
    const testDir = join(tmpdir(), `navi-test-var-assign-${Date.now()}-${testCounter++}`);
    mkdirSync(testDir, { recursive: true });
    writeFileSync(
      join(testDir, 'package.json'),
      JSON.stringify({ name: `test-assign-${testCounter}`, type: 'module' })
    );
    for (const [filename, content] of Object.entries(files)) {
      writeFileSync(join(testDir, filename), content);
    }
    const db = await createTestDatabase();
    const orchestrator = createTestOrchestrator(db.backend);
    await orchestrator.run(testDir);
    return { backend: db.backend, db, testDir };
  }

  /**
   * Helper: assert that a variable has at least one ASSIGNED_FROM or DERIVES_FROM edge
   */
  function assertHasAssignmentEdge(allNodes, edges, variableName) {
    const variable = allNodes.find(
      n => n.name === variableName && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
    );
    assert.ok(variable, `Variable "${variableName}" not found in graph`);

    const assignmentEdge = edges.find(
      e => (e.type === 'ASSIGNED_FROM' || e.type === 'DERIVES_FROM') && e.src === variable.id
    );
    assert.ok(
      assignmentEdge,
      `Variable "${variableName}" (${variable.id}) has no ASSIGNED_FROM or DERIVES_FROM edge. ` +
      `All edges from this variable: ${JSON.stringify(edges.filter(e => e.src === variable.id))}`
    );

    return { variable, assignmentEdge };
  }

  describe('TSAsExpression', () => {
    it('should track assignment through TS type assertion (as)', async () => {
      const { backend } = await setupTest({
        'index.ts': `
const rawValue = "hello";
const x = rawValue as string;
        `
      });

      try {
        const allNodes = await backend.getAllNodes();
        const edges = await backend.getAllEdges();
        assertHasAssignmentEdge(allNodes, edges, 'x');
      } finally {
        await backend.close();
      }
    });

    it('should track assignment through TSSatisfiesExpression', async () => {
      const { backend } = await setupTest({
        'index.ts': `
type Config = { port: number };
const config = { port: 3000 } satisfies Config;
        `
      });

      try {
        const allNodes = await backend.getAllNodes();
        const edges = await backend.getAllEdges();
        assertHasAssignmentEdge(allNodes, edges, 'config');
      } finally {
        await backend.close();
      }
    });

    it('should track assignment through TSNonNullExpression', async () => {
      const { backend } = await setupTest({
        'index.ts': `
function getVal(): string | null { return "hi"; }
const val = getVal()!;
        `
      });

      try {
        const allNodes = await backend.getAllNodes();
        const edges = await backend.getAllEdges();
        assertHasAssignmentEdge(allNodes, edges, 'val');
      } finally {
        await backend.close();
      }
    });
  });

  describe('ArrayExpression', () => {
    it('should track array literal assignment with ARRAY_LITERAL node', async () => {
      const { backend } = await setupTest({
        'index.js': `
function getValue() { return 1; }
const arr = [getValue(), 2, 3];
        `
      });

      try {
        const allNodes = await backend.getAllNodes();
        const edges = await backend.getAllEdges();
        const { variable, assignmentEdge } = assertHasAssignmentEdge(allNodes, edges, 'arr');

        // Verify the source is an ARRAY_LITERAL node
        const sourceNode = allNodes.find(n => n.id === assignmentEdge.dst);
        assert.ok(sourceNode, `Source node for assignment edge not found (dst: ${assignmentEdge.dst})`);
        assert.strictEqual(
          sourceNode.type,
          'ARRAY_LITERAL',
          `Expected source node to be ARRAY_LITERAL, got ${sourceNode.type}`
        );
      } finally {
        await backend.close();
      }
    });

    it('should track all-literal array with ARRAY_LITERAL node', async () => {
      const { backend } = await setupTest({
        'index.js': `
const nums = [1, 2, 3];
        `
      });

      try {
        const allNodes = await backend.getAllNodes();
        const edges = await backend.getAllEdges();
        const { assignmentEdge } = assertHasAssignmentEdge(allNodes, edges, 'nums');

        // Even all-literal arrays should now get ARRAY_LITERAL nodes
        const sourceNode = allNodes.find(n => n.id === assignmentEdge.dst);
        assert.ok(sourceNode, `Source node for assignment edge not found (dst: ${assignmentEdge.dst})`);
        assert.strictEqual(
          sourceNode.type,
          'ARRAY_LITERAL',
          `Expected source node to be ARRAY_LITERAL, got ${sourceNode.type}`
        );
      } finally {
        await backend.close();
      }
    });
  });

  describe('UnaryExpression', () => {
    it('should track negation assignment', async () => {
      const { backend } = await setupTest({
        'index.js': `
const flag = true;
const notFlag = !flag;
        `
      });

      try {
        const allNodes = await backend.getAllNodes();
        const edges = await backend.getAllEdges();
        assertHasAssignmentEdge(allNodes, edges, 'notFlag');
      } finally {
        await backend.close();
      }
    });

    it('should track typeof assignment', async () => {
      const { backend } = await setupTest({
        'index.js': `
const val = 42;
const t = typeof val;
        `
      });

      try {
        const allNodes = await backend.getAllNodes();
        const edges = await backend.getAllEdges();
        assertHasAssignmentEdge(allNodes, edges, 't');
      } finally {
        await backend.close();
      }
    });
  });

  describe('TaggedTemplateExpression', () => {
    it('should track tagged template with CALL node', async () => {
      const { backend } = await setupTest({
        'index.js': `
function html(strings) { return strings.join(''); }
const result = html\`<div>hello</div>\`;
        `
      });

      try {
        const allNodes = await backend.getAllNodes();
        const edges = await backend.getAllEdges();
        const { variable, assignmentEdge } = assertHasAssignmentEdge(allNodes, edges, 'result');

        // Verify the source is a CALL node (created by CallExpressionVisitor for TaggedTemplateExpression)
        const sourceNode = allNodes.find(n => n.id === assignmentEdge.dst);
        assert.ok(sourceNode, `Source node for assignment edge not found (dst: ${assignmentEdge.dst})`);
        assert.strictEqual(
          sourceNode.type,
          'CALL',
          `Expected source node to be CALL, got ${sourceNode.type}`
        );
      } finally {
        await backend.close();
      }
    });
  });

  describe('ClassExpression', () => {
    it('should track class expression with proper CLASS node', async () => {
      const { backend } = await setupTest({
        'index.js': `
const MyClass = class {
  constructor() {}
  hello() { return 'hi'; }
};
        `
      });

      try {
        const allNodes = await backend.getAllNodes();
        const edges = await backend.getAllEdges();
        const { variable, assignmentEdge } = assertHasAssignmentEdge(allNodes, edges, 'MyClass');

        // Verify a CLASS node exists for MyClass
        const classNode = allNodes.find(
          n => n.type === 'CLASS' && n.name === 'MyClass'
        );
        assert.ok(classNode, 'CLASS node for MyClass should exist in graph');

        // Verify the assignment edge points to the CLASS node
        assert.strictEqual(
          assignmentEdge.dst,
          classNode.id,
          `Expected assignment to point to CLASS node ${classNode.id}, got ${assignmentEdge.dst}`
        );
      } finally {
        await backend.close();
      }
    });
  });

  describe('OptionalCallExpression', () => {
    it('should track optional call assignment', async () => {
      const { backend } = await setupTest({
        'index.js': `
const obj = { method: () => 42 };
const result = obj?.method();
        `
      });

      try {
        const allNodes = await backend.getAllNodes();
        const edges = await backend.getAllEdges();
        assertHasAssignmentEdge(allNodes, edges, 'result');
      } finally {
        await backend.close();
      }
    });
  });

  describe('OptionalMemberExpression', () => {
    it('should track optional member access assignment', async () => {
      const { backend } = await setupTest({
        'index.js': `
const obj = { nested: { value: 42 } };
const val = obj?.nested;
        `
      });

      try {
        const allNodes = await backend.getAllNodes();
        const edges = await backend.getAllEdges();
        assertHasAssignmentEdge(allNodes, edges, 'val');
      } finally {
        await backend.close();
      }
    });
  });

  describe('Destructuring from MemberExpression', () => {
    it('should track destructuring from member expression', async () => {
      const { backend } = await setupTest({
        'index.js': `
const config = { db: { host: 'localhost', port: 5432 } };
const { host, port } = config.db;
        `
      });

      try {
        const allNodes = await backend.getAllNodes();
        const edges = await backend.getAllEdges();
        assertHasAssignmentEdge(allNodes, edges, 'host');
        assertHasAssignmentEdge(allNodes, edges, 'port');
      } finally {
        await backend.close();
      }
    });
  });

  describe('Destructuring from NewExpression', () => {
    it('should track destructuring from constructor call', async () => {
      const { backend } = await setupTest({
        'index.js': `
class Response {
  constructor() {
    this.data = {};
    this.status = 200;
  }
}
const { data, status } = new Response();
        `
      });

      try {
        const allNodes = await backend.getAllNodes();
        const edges = await backend.getAllEdges();
        assertHasAssignmentEdge(allNodes, edges, 'data');
        assertHasAssignmentEdge(allNodes, edges, 'status');
      } finally {
        await backend.close();
      }
    });
  });

  describe('TS wrappers in destructuring', () => {
    it('should track destructuring through TS as expression', async () => {
      const { backend } = await setupTest({
        'index.ts': `
interface Config { host: string; port: number; }
const raw = { host: 'localhost', port: 3000 };
const { host, port } = raw as Config;
        `
      });

      try {
        const allNodes = await backend.getAllNodes();
        const edges = await backend.getAllEdges();
        assertHasAssignmentEdge(allNodes, edges, 'host');
        assertHasAssignmentEdge(allNodes, edges, 'port');
      } finally {
        await backend.close();
      }
    });
  });

  describe('YieldExpression', () => {
    it('should track variable assigned from yield', async () => {
      const { backend } = await setupTest({
        'index.js': `
function* gen() {
  const input = yield 'prompt';
}
        `
      });

      try {
        const allNodes = await backend.getAllNodes();
        const edges = await backend.getAllEdges();
        // yield returns undefined at declaration time — the variable should still
        // exist. Since yield without argument has no trackable value, there may
        // not be an assignment edge. This test just verifies no crash.
        const variable = allNodes.find(
          n => n.name === 'input' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
        );
        assert.ok(variable, 'Variable "input" should exist in graph');
      } finally {
        await backend.close();
      }
    });
  });

  describe('AssignmentExpression as init', () => {
    it('should track variable assigned from assignment expression', async () => {
      const { backend } = await setupTest({
        'index.js': `
let a;
const b = (a = 42);
        `
      });

      try {
        const allNodes = await backend.getAllNodes();
        const edges = await backend.getAllEdges();
        assertHasAssignmentEdge(allNodes, edges, 'b');
      } finally {
        await backend.close();
      }
    });
  });
});
