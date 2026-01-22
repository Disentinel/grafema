/**
 * DecoratorNode Migration Tests (REG-106)
 *
 * TDD tests for migrating DECORATOR node creation to DecoratorNode factory.
 * Following pattern from InterfaceNodeMigration.test.js (REG-103) and EnumNodeMigration.test.js (REG-105).
 *
 * Verifies:
 * 1. DecoratorNode.create() generates ID with colon separator format
 * 2. Column is included in ID for disambiguation (multiple decorators per line)
 * 3. bufferDecoratorNodes should use DecoratorNode.create() instead of inline object
 * 4. targetId field is preserved in persisted node (BUG FIX)
 * 5. DECORATED_BY edge IDs should match between source and destination nodes
 *
 * ID format: {file}:DECORATOR:{name}:{line}:{column}
 * Example: /src/services/UserService.ts:DECORATOR:Injectable:5:0
 *
 * TDD: Tests written first per Kent Beck's methodology.
 * Some tests will FAIL initially - implementation comes after.
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';

import { DecoratorNode, NodeFactory } from '@grafema/core';
import { createTestBackend } from '../helpers/TestRFDB.js';
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';

let testCounter = 0;

/**
 * Helper to create a test project with given files
 * Note: For TypeScript features like decorators, files must be discoverable
 * through the dependency tree. We use index.ts as entry point.
 */
async function setupTest(backend, files) {
  const testDir = join(tmpdir(), `grafema-test-decorator-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  // package.json with main pointing to index.ts
  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({
      name: `test-decorator-${testCounter}`,
      type: 'module',
      main: 'index.ts'
    })
  );

  // Create test files
  for (const [filename, content] of Object.entries(files)) {
    writeFileSync(join(testDir, filename), content);
  }

  const orchestrator = createTestOrchestrator(backend, { forceAnalysis: true });
  await orchestrator.run(testDir);

  return { testDir };
}

// ============================================================================
// 1. DecoratorNode.create() ID format verification (Unit Tests)
// ============================================================================

describe('DecoratorNode Migration (REG-106)', () => {
  describe('DecoratorNode.create() ID format', () => {
    it('should generate ID with colon separator', () => {
      const node = DecoratorNode.create(
        'Injectable',
        '/project/src/services.ts',
        5,
        0,
        '/project/src/services.ts:CLASS:UserService:5',
        'CLASS'
      );

      // ID format: {file}:DECORATOR:{name}:{line}:{column}
      assert.strictEqual(
        node.id,
        '/project/src/services.ts:DECORATOR:Injectable:5:0',
        'ID should use colon separators'
      );
    });

    it('should NOT use # separator in ID', () => {
      const node = DecoratorNode.create(
        'Component',
        '/project/src/components.ts',
        10,
        0,
        '/project/src/components.ts:CLASS:MyComponent:10',
        'CLASS'
      );

      assert.ok(
        !node.id.includes('#'),
        `ID should NOT contain # separator: ${node.id}`
      );
    });

    it('should include column for disambiguation (multiple decorators on same line)', () => {
      // Two decorators on same line, different columns
      const decorator1 = DecoratorNode.create(
        'Auth',
        '/project/src/controller.ts',
        15,
        0,
        '/project/src/controller.ts:METHOD:getUser:15',
        'METHOD'
      );

      const decorator2 = DecoratorNode.create(
        'Log',
        '/project/src/controller.ts',
        15,
        10,
        '/project/src/controller.ts:METHOD:getUser:15',
        'METHOD'
      );

      // Different columns = different IDs
      assert.notStrictEqual(decorator1.id, decorator2.id,
        'Same line but different columns should have different IDs');

      // Both should include column in ID
      assert.ok(decorator1.id.endsWith(':0'),
        `First decorator ID should end with column 0: ${decorator1.id}`);
      assert.ok(decorator2.id.endsWith(':10'),
        `Second decorator ID should end with column 10: ${decorator2.id}`);
    });

    it('should follow pattern: {file}:DECORATOR:{name}:{line}:{column}', () => {
      const node = DecoratorNode.create(
        'Validate',
        '/src/validators.ts',
        25,
        5,
        '/src/validators.ts:METHOD:validate:25',
        'METHOD'
      );

      const parts = node.id.split(':');
      assert.strictEqual(parts.length, 5, 'ID should have 5 parts separated by :');
      assert.strictEqual(parts[0], '/src/validators.ts', 'First part should be file');
      assert.strictEqual(parts[1], 'DECORATOR', 'Second part should be DECORATOR');
      assert.strictEqual(parts[2], 'Validate', 'Third part should be name');
      assert.strictEqual(parts[3], '25', 'Fourth part should be line');
      assert.strictEqual(parts[4], '5', 'Fifth part should be column');
    });

    it('should require targetId and targetType fields', () => {
      // DecoratorNode.create requires targetId and targetType
      assert.throws(
        () => DecoratorNode.create('Test', '/file.ts', 1, 0, '', 'CLASS'),
        /targetId is required/,
        'Should throw when targetId is empty'
      );

      assert.throws(
        () => DecoratorNode.create('Test', '/file.ts', 1, 0, 'some-target', ''),
        /targetType is required/,
        'Should throw when targetType is empty'
      );
    });

    it('should preserve all required and optional fields', () => {
      const node = DecoratorNode.create(
        'Inject',
        '/project/services.ts',
        15,
        5,
        '/project/services.ts:PARAMETER:constructor:15',
        'PARAMETER',
        { arguments: ['UserRepository'] }
      );

      assert.strictEqual(node.type, 'DECORATOR');
      assert.strictEqual(node.name, 'Inject');
      assert.strictEqual(node.file, '/project/services.ts');
      assert.strictEqual(node.line, 15);
      assert.strictEqual(node.column, 5);
      assert.strictEqual(node.targetId, '/project/services.ts:PARAMETER:constructor:15');
      assert.strictEqual(node.targetType, 'PARAMETER');
      assert.deepStrictEqual(node.arguments, ['UserRepository']);
    });

    it('should handle all targetType values: CLASS, METHOD, PROPERTY, PARAMETER', () => {
      const classDecorator = DecoratorNode.create(
        'Entity',
        '/file.ts',
        5,
        0,
        'target-class',
        'CLASS'
      );
      assert.strictEqual(classDecorator.targetType, 'CLASS');

      const methodDecorator = DecoratorNode.create(
        'Get',
        '/file.ts',
        10,
        0,
        'target-method',
        'METHOD'
      );
      assert.strictEqual(methodDecorator.targetType, 'METHOD');

      const propertyDecorator = DecoratorNode.create(
        'Column',
        '/file.ts',
        15,
        0,
        'target-property',
        'PROPERTY'
      );
      assert.strictEqual(propertyDecorator.targetType, 'PROPERTY');

      const parameterDecorator = DecoratorNode.create(
        'Param',
        '/file.ts',
        20,
        0,
        'target-parameter',
        'PARAMETER'
      );
      assert.strictEqual(parameterDecorator.targetType, 'PARAMETER');
    });

    it('should create consistent IDs for same parameters', () => {
      const node1 = DecoratorNode.create(
        'Injectable',
        '/file.ts',
        10,
        0,
        'target-id',
        'CLASS'
      );
      const node2 = DecoratorNode.create(
        'Injectable',
        '/file.ts',
        10,
        0,
        'target-id',
        'CLASS'
      );

      assert.strictEqual(node1.id, node2.id,
        'Same parameters should produce same ID');
    });
  });

  // ============================================================================
  // 2. DecoratorNode validation tests
  // ============================================================================

  describe('DecoratorNode validation', () => {
    it('should return empty errors for valid decorator node', () => {
      const node = DecoratorNode.create(
        'Injectable',
        '/project/src/services.ts',
        5,
        0,
        '/project/src/services.ts:CLASS:UserService:5',
        'CLASS'
      );

      const errors = DecoratorNode.validate(node);
      assert.strictEqual(errors.length, 0,
        `Expected no validation errors, got: ${JSON.stringify(errors)}`);
    });

    it('should detect missing required fields', () => {
      // Create a node with missing targetId
      const invalidNode = {
        id: '/file.ts:DECORATOR:Test:1:0',
        type: 'DECORATOR',
        name: 'Test',
        file: '/file.ts',
        line: 1,
        column: 0,
        arguments: [],
        // Missing: targetId, targetType
        targetType: 'CLASS'
      };

      const errors = DecoratorNode.validate(invalidNode);
      assert.ok(errors.length > 0, 'Should have validation errors');
      assert.ok(
        errors.some(e => e.includes('targetId')),
        `Should report missing targetId: ${JSON.stringify(errors)}`
      );
    });
  });

  // ============================================================================
  // 3. NodeFactory.createDecorator compatibility
  // ============================================================================

  describe('NodeFactory.createDecorator compatibility', () => {
    it('should produce same result as DecoratorNode.create', () => {
      const viaNodeFactory = NodeFactory.createDecorator(
        'Injectable',
        '/file.ts',
        10,
        0,
        'target-class-id',
        'CLASS',
        { arguments: ['singleton'] }
      );

      const viaDecoratorNode = DecoratorNode.create(
        'Injectable',
        '/file.ts',
        10,
        0,
        'target-class-id',
        'CLASS',
        { arguments: ['singleton'] }
      );

      assert.deepStrictEqual(viaNodeFactory, viaDecoratorNode,
        'NodeFactory.createDecorator should produce same result as DecoratorNode.create');
    });

    it('should pass validation through NodeFactory', () => {
      const node = NodeFactory.createDecorator(
        'Controller',
        '/project/controllers.ts',
        15,
        0,
        '/project/controllers.ts:CLASS:UserController:15',
        'CLASS',
        { arguments: ['/users'] }
      );

      const errors = NodeFactory.validate(node);
      assert.strictEqual(errors.length, 0,
        `Expected no validation errors, got: ${JSON.stringify(errors)}`);
    });
  });

  // ============================================================================
  // 4. GraphBuilder integration tests
  //
  // NOTE: These tests require:
  // 1. Babel parser configured with 'decorators-legacy' plugin in JSASTAnalyzer
  // 2. bufferDecoratorNodes() migration to use DecoratorNode.create()
  //
  // Currently JSASTAnalyzer uses: plugins: ['jsx', 'typescript']
  // Missing: 'decorators-legacy' plugin
  //
  // Run these tests after both prerequisites are met.
  // ============================================================================

  describe('GraphBuilder integration', () => {
    let backend;

    beforeEach(async () => {
      if (backend) {
        await backend.cleanup();
      }
      backend = createTestBackend();
      await backend.connect();
    });

    after(async () => {
      if (backend) {
        await backend.cleanup();
      }
    });

    it('should create DECORATED_BY edge with colon format IDs', { skip: 'Requires decorators-legacy plugin in JSASTAnalyzer' }, async () => {
      await setupTest(backend, {
        'index.ts': `
function Injectable() {
  return function(target: any) {};
}

@Injectable()
export class UserService {
  getUser() { return null; }
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const decoratorNode = allNodes.find(n =>
        n.name === 'Injectable' && n.type === 'DECORATOR'
      );

      assert.ok(decoratorNode, 'DECORATOR node "Injectable" not found');

      // ID should use colon format (DecoratorNode.create pattern)
      // After migration: {file}:DECORATOR:Injectable:{line}:{column}
      assert.ok(
        decoratorNode.id.includes(':DECORATOR:Injectable:'),
        `ID should use colon format: ${decoratorNode.id}`
      );

      // Should NOT have legacy # format
      assert.ok(
        !decoratorNode.id.includes('DECORATOR#'),
        `ID should NOT use legacy # format: ${decoratorNode.id}`
      );

      // Find DECORATED_BY edge
      const decoratedByEdge = allEdges.find(e =>
        e.type === 'DECORATED_BY' &&
        e.dst === decoratorNode.id
      );

      assert.ok(decoratedByEdge,
        `DECORATED_BY edge with dst ${decoratorNode.id} not found`);

      // Edge dst should use colon format (same as node ID)
      assert.ok(
        decoratedByEdge.dst.includes(':DECORATOR:'),
        `DECORATED_BY edge dst should use colon format: ${decoratedByEdge.dst}`
      );
    });

    it('should include targetId in persisted decorator node (BUG FIX)', { skip: 'Requires decorators-legacy plugin in JSASTAnalyzer' }, async () => {
      await setupTest(backend, {
        'index.ts': `
function Component() {
  return function(target: any) {};
}

@Component()
export class MyComponent {
  render() { return null; }
}
        `
      });

      const allNodes = await backend.getAllNodes();

      const decoratorNode = allNodes.find(n =>
        n.name === 'Component' && n.type === 'DECORATOR'
      );

      assert.ok(decoratorNode, 'DECORATOR node not found');

      // BUG FIX: targetId should be persisted in the node
      assert.ok(decoratorNode.targetId,
        `targetId should be present in persisted node: ${JSON.stringify(decoratorNode)}`);

      // targetId should reference the decorated class
      assert.ok(
        decoratorNode.targetId.includes(':CLASS:MyComponent:'),
        `targetId should reference MyComponent class: ${decoratorNode.targetId}`
      );
    });

    it('should create DECORATED_BY edge with correct node IDs', { skip: 'Requires decorators-legacy plugin in JSASTAnalyzer' }, async () => {
      await setupTest(backend, {
        'index.ts': `
function Entity() {
  return function(target: any) {};
}

@Entity()
export class User {
  id: string;
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const classNode = allNodes.find(n =>
        n.name === 'User' && n.type === 'CLASS'
      );
      const decoratorNode = allNodes.find(n =>
        n.name === 'Entity' && n.type === 'DECORATOR'
      );

      assert.ok(classNode, 'CLASS node "User" not found');
      assert.ok(decoratorNode, 'DECORATOR node "Entity" not found');

      // Find DECORATED_BY edge from class to decorator
      const decoratedByEdge = allEdges.find(e =>
        e.type === 'DECORATED_BY' &&
        e.src === classNode.id &&
        e.dst === decoratorNode.id
      );

      assert.ok(decoratedByEdge,
        `DECORATED_BY edge from ${classNode.id} to ${decoratorNode.id} not found`);

      // Edge src/dst should match node IDs exactly
      assert.strictEqual(decoratedByEdge.src, classNode.id,
        'DECORATED_BY src should match class node ID');
      assert.strictEqual(decoratedByEdge.dst, decoratorNode.id,
        'DECORATED_BY dst should match decorator node ID');
    });

    it('should handle multiple decorators on same target', { skip: 'Requires decorators-legacy plugin in JSASTAnalyzer' }, async () => {
      await setupTest(backend, {
        'index.ts': `
function Injectable() {
  return function(target: any) {};
}

function Singleton() {
  return function(target: any) {};
}

@Injectable()
@Singleton()
export class ConfigService {
  get() { return {}; }
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const classNode = allNodes.find(n =>
        n.name === 'ConfigService' && n.type === 'CLASS'
      );
      const injectableDecorator = allNodes.find(n =>
        n.name === 'Injectable' && n.type === 'DECORATOR'
      );
      const singletonDecorator = allNodes.find(n =>
        n.name === 'Singleton' && n.type === 'DECORATOR'
      );

      assert.ok(classNode, 'CLASS node "ConfigService" not found');
      assert.ok(injectableDecorator, 'DECORATOR node "Injectable" not found');
      assert.ok(singletonDecorator, 'DECORATOR node "Singleton" not found');

      // Both decorators should have unique IDs
      assert.notStrictEqual(injectableDecorator.id, singletonDecorator.id,
        'Different decorators should have different IDs');

      // Should have DECORATED_BY edges to both decorators
      const decoratedByEdges = allEdges.filter(e =>
        e.type === 'DECORATED_BY' &&
        e.src === classNode.id
      );

      assert.strictEqual(decoratedByEdges.length, 2,
        `Should have 2 DECORATED_BY edges from ConfigService, found: ${decoratedByEdges.length}`);
    });

    it('should handle decorators on methods', { skip: 'Requires decorators-legacy plugin in JSASTAnalyzer' }, async () => {
      await setupTest(backend, {
        'index.ts': `
function Get() {
  return function(target: any, key: string) {};
}

export class Controller {
  @Get()
  getUsers() {
    return [];
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();

      const decoratorNode = allNodes.find(n =>
        n.name === 'Get' && n.type === 'DECORATOR'
      );

      assert.ok(decoratorNode, 'DECORATOR node "Get" not found');

      // Should have METHOD as targetType
      assert.strictEqual(decoratorNode.targetType, 'METHOD',
        'Method decorator should have targetType: METHOD');

      // ID should use colon format
      assert.ok(
        decoratorNode.id.includes(':DECORATOR:Get:'),
        `ID should use colon format: ${decoratorNode.id}`
      );
    });

    it('should handle decorators with arguments', { skip: 'Requires decorators-legacy plugin in JSASTAnalyzer' }, async () => {
      await setupTest(backend, {
        'index.ts': `
function Controller(path: string) {
  return function(target: any) {};
}

@Controller('/api/users')
export class UserController {
  index() { return []; }
}
        `
      });

      const allNodes = await backend.getAllNodes();

      const decoratorNode = allNodes.find(n =>
        n.name === 'Controller' && n.type === 'DECORATOR'
      );

      assert.ok(decoratorNode, 'DECORATOR node "Controller" not found');

      // Should have arguments captured
      assert.ok(Array.isArray(decoratorNode.arguments),
        'arguments should be an array');

      // ID should use colon format
      assert.ok(
        decoratorNode.id.includes(':DECORATOR:Controller:'),
        `ID should use colon format: ${decoratorNode.id}`
      );
    });

    it('should handle decorators on properties', { skip: 'Requires decorators-legacy plugin in JSASTAnalyzer' }, async () => {
      await setupTest(backend, {
        'index.ts': `
function Column() {
  return function(target: any, key: string) {};
}

export class Entity {
  @Column()
  name: string;
}
        `
      });

      const allNodes = await backend.getAllNodes();

      const decoratorNode = allNodes.find(n =>
        n.name === 'Column' && n.type === 'DECORATOR'
      );

      assert.ok(decoratorNode, 'DECORATOR node "Column" not found');

      // Should have PROPERTY as targetType
      assert.strictEqual(decoratorNode.targetType, 'PROPERTY',
        'Property decorator should have targetType: PROPERTY');

      // ID should use colon format
      assert.ok(
        decoratorNode.id.includes(':DECORATOR:Column:'),
        `ID should use colon format: ${decoratorNode.id}`
      );
    });

    it('should handle decorators on parameters', { skip: 'Requires decorators-legacy plugin in JSASTAnalyzer' }, async () => {
      await setupTest(backend, {
        'index.ts': `
function Inject() {
  return function(target: any, key: string, index: number) {};
}

class Repository {}

export class Service {
  constructor(@Inject() repo: Repository) {}
}
        `
      });

      const allNodes = await backend.getAllNodes();

      const decoratorNode = allNodes.find(n =>
        n.name === 'Inject' && n.type === 'DECORATOR'
      );

      assert.ok(decoratorNode, 'DECORATOR node "Inject" not found');

      // Should have PARAMETER as targetType
      assert.strictEqual(decoratorNode.targetType, 'PARAMETER',
        'Parameter decorator should have targetType: PARAMETER');

      // ID should use colon format
      assert.ok(
        decoratorNode.id.includes(':DECORATOR:Inject:'),
        `ID should use colon format: ${decoratorNode.id}`
      );
    });

    it('should NOT use DECORATOR# format in analyzed code', { skip: 'Requires decorators-legacy plugin in JSASTAnalyzer' }, async () => {
      await setupTest(backend, {
        'index.ts': `
function Log() {
  return function(target: any) {};
}

@Log()
export class LoggedService {}
        `
      });

      const allNodes = await backend.getAllNodes();
      const decoratorNode = allNodes.find(n =>
        n.name === 'Log' && n.type === 'DECORATOR'
      );

      assert.ok(decoratorNode, 'DECORATOR node "Log" not found');

      // Check ID format
      assert.ok(
        !decoratorNode.id.includes('DECORATOR#'),
        `ID should NOT contain legacy DECORATOR# format: ${decoratorNode.id}`
      );

      assert.ok(
        decoratorNode.id.includes(':DECORATOR:'),
        `ID should use colon format: ${decoratorNode.id}`
      );
    });
  });
});
