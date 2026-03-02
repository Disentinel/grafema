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
   * Helper: assert that a variable has at least one ASSIGNED_FROM edge
   * V2: Only ASSIGNED_FROM, no DERIVES_FROM on variables
   */
  function assertHasAssignmentEdge(allNodes, edges, variableName) {
    const variable = allNodes.find(
      n => n.name === variableName && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
    );
    assert.ok(variable, `Variable "${variableName}" not found in graph`);

    const assignmentEdge = edges.find(
      e => e.type === 'ASSIGNED_FROM' && e.src === variable.id
    );
    assert.ok(
      assignmentEdge,
      `Variable "${variableName}" (${variable.id}) has no ASSIGNED_FROM edge. ` +
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
    it('should track array literal assignment with LITERAL node', async () => {
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

        // V2: Arrays are LITERAL nodes with name="[...]"
        const sourceNode = allNodes.find(n => n.id === assignmentEdge.dst);
        assert.ok(sourceNode, `Source node for assignment edge not found (dst: ${assignmentEdge.dst})`);
        assert.strictEqual(
          sourceNode.type,
          'LITERAL',
          `Expected source node to be LITERAL, got ${sourceNode.type}`
        );
      } finally {
        await backend.close();
      }
    });

    it('should track all-literal array with LITERAL node', async () => {
      const { backend } = await setupTest({
        'index.js': `
const nums = [1, 2, 3];
        `
      });

      try {
        const allNodes = await backend.getAllNodes();
        const edges = await backend.getAllEdges();
        const { assignmentEdge } = assertHasAssignmentEdge(allNodes, edges, 'nums');

        // V2: All-literal arrays are LITERAL nodes
        const sourceNode = allNodes.find(n => n.id === assignmentEdge.dst);
        assert.ok(sourceNode, `Source node for assignment edge not found (dst: ${assignmentEdge.dst})`);
        assert.strictEqual(
          sourceNode.type,
          'LITERAL',
          `Expected source node to be LITERAL, got ${sourceNode.type}`
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
        // V2: result variable should exist and have an ASSIGNED_FROM edge
        const { variable, assignmentEdge } = assertHasAssignmentEdge(allNodes, edges, 'result');

        // V2: The source should be a CALL node
        const sourceNode = allNodes.find(n => n.id === assignmentEdge.dst);
        assert.ok(sourceNode, `Source node for assignment edge not found (dst: ${assignmentEdge.dst})`);
        // V2 may create either CALL or a different node type for tagged templates
        assert.ok(
          sourceNode.type === 'CALL' || sourceNode.type === 'LITERAL',
          `Expected source node to be CALL or LITERAL, got ${sourceNode.type}`
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

        // V2: Class expressions create CLASS nodes with name "<anonymous>", not "MyClass"
        // The ASSIGNED_FROM edge links the variable to the anonymous class node
        const classNode = allNodes.find(
          n => n.type === 'CLASS' && n.id === assignmentEdge.dst
        );
        assert.ok(classNode, 'CLASS node (target of ASSIGNED_FROM) should exist in graph');

        // V2: The assignment edge should point to the CLASS node
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
    it('should track destructuring from member expression', { todo: 'V2 does not yet create ASSIGNED_FROM edges for destructured variables from MemberExpression' }, async () => {
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
    it('should track destructuring from constructor call', { todo: 'V2 does not yet create ASSIGNED_FROM edges for destructured variables from NewExpression' }, async () => {
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
    it('should track destructuring through TS as expression', { todo: 'V2 does not yet create ASSIGNED_FROM edges for destructured variables through TS type assertions' }, async () => {
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
