/**
 * TypeScript Class Extraction Tests (REG-427)
 *
 * Verifies that TypeScript .ts files are properly discovered, indexed, and
 * analyzed so that CLASS nodes are extracted from TypeScript source code.
 *
 * Root cause of REG-427: JSModuleIndexer received 'index.js' as entrypoint
 * but only 'index.ts' existed on disk. The file was not found, nothing was
 * indexed, and no CLASS nodes were created.
 *
 * Fix: JSModuleIndexer resolves the entrypoint through resolveModulePath()
 * before starting DFS traversal, allowing .js -> .ts resolution.
 *
 * Test cases:
 * 1. Basic: .ts file with class -> CLASS node extracted (main regression test)
 * 2. Abstract class -> CLASS node extracted
 * 3. Class with extends -> correct superClass metadata
 * 4. Class with TypeScript access modifiers (private, protected, public)
 * 5. Exported class -> exported flag set
 * 6. Class with TypeScript-specific features (implements, generics)
 *
 * TDD: Tests written first per Kent Beck's methodology.
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';

import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';

// Cleanup all test databases after all tests complete
after(cleanupAllTestDatabases);

let testCounter = 0;

/**
 * Helper to create a TypeScript test project with given files.
 *
 * Automatically creates:
 * - package.json with type: 'module'
 * - tsconfig.json (required for TS source discovery)
 * - All provided files
 *
 * The tsconfig.json is essential: without it, resolveSourceEntrypoint()
 * returns null and the project falls back to 'index.js', which is the
 * root cause of REG-427.
 */
async function setupTest(backend, files) {
  const testDir = join(tmpdir(), `grafema-test-ts-class-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  // package.json — type: 'module' for ESM
  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({
      name: `test-ts-class-${testCounter}`,
      type: 'module'
    })
  );

  // tsconfig.json — signals this is a TypeScript project
  // resolveSourceEntrypoint() checks for this file to prefer .ts over .js
  writeFileSync(
    join(testDir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2020',
        module: 'ESNext',
        strict: true
      }
    })
  );

  // Create test files
  for (const [filename, content] of Object.entries(files)) {
    const filePath = join(testDir, filename);
    const dir = filePath.substring(0, filePath.lastIndexOf('/'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, content);
  }

  const orchestrator = createTestOrchestrator(backend);
  await orchestrator.run(testDir);

  return { testDir };
}

describe('TypeScript class extraction (REG-427)', () => {
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

  // ===========================================================================
  // 1. Basic: .ts file with class -> CLASS node extracted
  //    This is the main regression test for REG-427
  // ===========================================================================

  describe('basic .ts class extraction (regression test)', () => {
    it('should extract CLASS node from .ts file', async () => {
      await setupTest(backend, {
        'index.ts': `
class User {
  name: string;

  constructor(name: string) {
    this.name = name;
  }

  getName(): string {
    return this.name;
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const classNode = allNodes.find(n =>
        n.name === 'User' && n.type === 'CLASS'
      );

      assert.ok(classNode, 'CLASS node "User" should be extracted from .ts file');
      assert.strictEqual(classNode.type, 'CLASS', 'Node type should be CLASS');
      assert.strictEqual(classNode.name, 'User', 'Class name should be User');
      assert.ok(classNode.file, 'CLASS node should have a file field');
      assert.ok(typeof classNode.line === 'number', 'CLASS node should have a line number');
    });

    it('should extract multiple classes from a single .ts file', async () => {
      await setupTest(backend, {
        'index.ts': `
class First {}
class Second {}
class Third {}
        `
      });

      const allNodes = await backend.getAllNodes();
      const classNodes = allNodes.filter(n => n.type === 'CLASS');
      const classNames = classNodes.map(n => n.name).sort();

      assert.ok(classNames.includes('First'), 'CLASS "First" should be extracted');
      assert.ok(classNames.includes('Second'), 'CLASS "Second" should be extracted');
      assert.ok(classNames.includes('Third'), 'CLASS "Third" should be extracted');
    });

    it('should create CLASS nodes with semantic ID format', async () => {
      await setupTest(backend, {
        'index.ts': `
class Config {
  constructor(public options: Record<string, unknown>) {}
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const classNode = allNodes.find(n =>
        n.name === 'Config' && n.type === 'CLASS'
      );

      assert.ok(classNode, 'CLASS node "Config" not found');
      assert.ok(
        classNode.id.includes('->CLASS->Config'),
        `ID should have semantic CLASS format, got: ${classNode.id}`
      );
    });
  });

  // ===========================================================================
  // 2. Abstract class -> CLASS node extracted
  // ===========================================================================

  describe('abstract class extraction', () => {
    it('should extract abstract class as CLASS node', async () => {
      await setupTest(backend, {
        'index.ts': `
abstract class BaseService {
  abstract execute(): Promise<void>;

  log(message: string): void {
    console.log(message);
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const classNode = allNodes.find(n =>
        n.name === 'BaseService' && n.type === 'CLASS'
      );

      assert.ok(classNode, 'Abstract class "BaseService" should be extracted as CLASS node');
      assert.strictEqual(classNode.type, 'CLASS', 'Abstract class should have type CLASS');
    });

    it('should extract both abstract and concrete classes', async () => {
      await setupTest(backend, {
        'index.ts': `
abstract class Shape {
  abstract area(): number;
}

class Circle extends Shape {
  constructor(private radius: number) {
    super();
  }

  area(): number {
    return Math.PI * this.radius * this.radius;
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const shapeNode = allNodes.find(n => n.name === 'Shape' && n.type === 'CLASS');
      const circleNode = allNodes.find(n => n.name === 'Circle' && n.type === 'CLASS');

      assert.ok(shapeNode, 'Abstract class "Shape" should be extracted');
      assert.ok(circleNode, 'Concrete class "Circle" should be extracted');
    });
  });

  // ===========================================================================
  // 3. Class with extends -> correct superClass metadata
  // ===========================================================================

  describe('class inheritance (extends)', () => {
    it('should set superClass when class extends another', async () => {
      await setupTest(backend, {
        'index.ts': `
class Animal {
  name: string;

  constructor(name: string) {
    this.name = name;
  }
}

class Dog extends Animal {
  breed: string;

  constructor(name: string, breed: string) {
    super(name);
    this.breed = breed;
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const dogNode = allNodes.find(n =>
        n.name === 'Dog' && n.type === 'CLASS'
      );

      assert.ok(dogNode, 'CLASS node "Dog" not found');
      assert.strictEqual(dogNode.superClass, 'Animal', 'superClass should be "Animal"');
    });

    it('should have null/undefined superClass when no extends clause', async () => {
      await setupTest(backend, {
        'index.ts': `
class Standalone {
  value: number = 42;
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const standaloneNode = allNodes.find(n =>
        n.name === 'Standalone' && n.type === 'CLASS'
      );

      assert.ok(standaloneNode, 'CLASS node "Standalone" not found');
      assert.ok(
        standaloneNode.superClass === null || standaloneNode.superClass === undefined,
        'superClass should be null or undefined when no extends clause'
      );
    });

    it('should handle multi-level inheritance chain', async () => {
      await setupTest(backend, {
        'index.ts': `
class Base {
  id: string = '';
}

class Middle extends Base {
  name: string = '';
}

class Leaf extends Middle {
  value: number = 0;
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const middleNode = allNodes.find(n => n.name === 'Middle' && n.type === 'CLASS');
      const leafNode = allNodes.find(n => n.name === 'Leaf' && n.type === 'CLASS');

      assert.ok(middleNode, 'CLASS node "Middle" not found');
      assert.strictEqual(middleNode.superClass, 'Base', 'Middle.superClass should be "Base"');

      assert.ok(leafNode, 'CLASS node "Leaf" not found');
      assert.strictEqual(leafNode.superClass, 'Middle', 'Leaf.superClass should be "Middle"');
    });
  });

  // ===========================================================================
  // 4. Class with TypeScript access modifiers
  // ===========================================================================

  describe('TypeScript access modifiers', () => {
    it('should extract class with private/protected/public constructor params', async () => {
      await setupTest(backend, {
        'index.ts': `
class UserService {
  constructor(
    private readonly db: unknown,
    protected logger: unknown,
    public name: string
  ) {}

  getUser(id: string): unknown {
    return null;
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const classNode = allNodes.find(n =>
        n.name === 'UserService' && n.type === 'CLASS'
      );

      assert.ok(classNode, 'CLASS node "UserService" should be extracted despite TS access modifiers');
      assert.strictEqual(classNode.type, 'CLASS');
    });

    it('should extract class with readonly properties', async () => {
      await setupTest(backend, {
        'index.ts': `
class Config {
  readonly version: string = '1.0';
  private readonly secret: string;

  constructor(secret: string) {
    this.secret = secret;
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const classNode = allNodes.find(n =>
        n.name === 'Config' && n.type === 'CLASS'
      );

      assert.ok(classNode, 'CLASS node "Config" should be extracted with readonly properties');
    });

    it('should extract methods from class with access modifiers', async () => {
      await setupTest(backend, {
        'index.ts': `
class Repository {
  private items: string[] = [];

  public add(item: string): void {
    this.items.push(item);
  }

  protected validate(item: string): boolean {
    return item.length > 0;
  }

  private log(msg: string): void {
    console.log(msg);
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const classNode = allNodes.find(n =>
        n.name === 'Repository' && n.type === 'CLASS'
      );

      assert.ok(classNode, 'CLASS node "Repository" should be extracted');

      // Check that FUNCTION nodes exist for the methods
      const methodNodes = allNodes.filter(n =>
        n.type === 'FUNCTION' && n.file && n.file.endsWith('index.ts')
      );
      const methodNames = methodNodes.map(n => n.name);

      assert.ok(methodNames.includes('add'), 'Public method "add" should be extracted');
      assert.ok(methodNames.includes('validate'), 'Protected method "validate" should be extracted');
      assert.ok(methodNames.includes('log'), 'Private method "log" should be extracted');
    });
  });

  // ===========================================================================
  // 5. Exported class -> exported flag set
  // ===========================================================================

  describe('exported classes', () => {
    it('should extract exported class as CLASS node with EXPORT node', async () => {
      // Note: GraphBuilder doesn't buffer 'exported' flag on CLASS nodes.
      // Exports are represented as separate EXPORT nodes connected to MODULE.
      // We verify both: CLASS node exists AND EXPORT node exists for it.
      await setupTest(backend, {
        'index.ts': `
export class PublicApi {
  call(): void {}
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const classNode = allNodes.find(n =>
        n.name === 'PublicApi' && n.type === 'CLASS'
      );

      assert.ok(classNode, 'CLASS node "PublicApi" should be extracted');

      // Verify EXPORT node exists for this class
      const exportNode = allNodes.find(n =>
        n.type === 'EXPORT' && n.name === 'PublicApi'
      );
      assert.ok(exportNode, 'EXPORT node for "PublicApi" should exist');
    });

    it('should not create EXPORT node for non-exported class', async () => {
      await setupTest(backend, {
        'index.ts': `
class InternalHelper {
  process(): void {}
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const classNode = allNodes.find(n =>
        n.name === 'InternalHelper' && n.type === 'CLASS'
      );

      assert.ok(classNode, 'CLASS node "InternalHelper" not found');

      // No EXPORT node should exist for non-exported class
      const exportNode = allNodes.find(n =>
        n.type === 'EXPORT' && n.name === 'InternalHelper'
      );
      assert.ok(!exportNode, 'EXPORT node should NOT exist for non-exported class');
    });

    it('should handle export default class', async () => {
      await setupTest(backend, {
        'index.ts': `
export default class MainController {
  handle(): void {}
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const classNode = allNodes.find(n =>
        n.name === 'MainController' && n.type === 'CLASS'
      );

      assert.ok(classNode, 'Default exported class "MainController" should be extracted');
    });

    it('should create EXPORT node only for exported class, not internal', async () => {
      await setupTest(backend, {
        'index.ts': `
export class Exported {
  run(): void {}
}

class Internal {
  helper(): void {}
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const exportedNode = allNodes.find(n =>
        n.name === 'Exported' && n.type === 'CLASS'
      );
      const internalNode = allNodes.find(n =>
        n.name === 'Internal' && n.type === 'CLASS'
      );

      assert.ok(exportedNode, 'Exported class should be found as CLASS node');
      assert.ok(internalNode, 'Internal class should be found as CLASS node');

      // EXPORT node exists for exported class
      const exportNodeForExported = allNodes.find(n =>
        n.type === 'EXPORT' && n.name === 'Exported'
      );
      assert.ok(exportNodeForExported, 'EXPORT node should exist for exported class');

      // No EXPORT node for internal class
      const exportNodeForInternal = allNodes.find(n =>
        n.type === 'EXPORT' && n.name === 'Internal'
      );
      assert.ok(!exportNodeForInternal, 'EXPORT node should NOT exist for internal class');
    });
  });

  // ===========================================================================
  // 6. TypeScript-specific features (implements, generics)
  // ===========================================================================

  describe('TypeScript-specific features', () => {
    it('should extract class with implements clause', async () => {
      await setupTest(backend, {
        'index.ts': `
interface Serializable {
  serialize(): string;
}

interface Loggable {
  log(): void;
}

class Document implements Serializable, Loggable {
  serialize(): string {
    return JSON.stringify(this);
  }

  log(): void {
    console.log(this.serialize());
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const classNode = allNodes.find(n =>
        n.name === 'Document' && n.type === 'CLASS'
      );

      assert.ok(classNode, 'CLASS node "Document" should be extracted despite implements clause');
      assert.strictEqual(classNode.type, 'CLASS');
    });

    it('should extract class with generic type parameters', async () => {
      await setupTest(backend, {
        'index.ts': `
class Container<T> {
  private items: T[] = [];

  add(item: T): void {
    this.items.push(item);
  }

  get(index: number): T {
    return this.items[index];
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const classNode = allNodes.find(n =>
        n.name === 'Container' && n.type === 'CLASS'
      );

      assert.ok(classNode, 'CLASS node "Container<T>" should be extracted despite generic params');
      assert.strictEqual(classNode.name, 'Container', 'Name should be "Container" without generics');
    });

    it('should extract class with both extends and implements', async () => {
      await setupTest(backend, {
        'index.ts': `
interface Disposable {
  dispose(): void;
}

class Resource {
  id: string = '';
}

class ManagedResource extends Resource implements Disposable {
  dispose(): void {
    console.log('disposing');
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const classNode = allNodes.find(n =>
        n.name === 'ManagedResource' && n.type === 'CLASS'
      );

      assert.ok(classNode, 'CLASS "ManagedResource" should be extracted with extends + implements');
      assert.strictEqual(classNode.superClass, 'Resource', 'superClass should be "Resource"');
    });

    it('should extract class with constrained generics', async () => {
      await setupTest(backend, {
        'index.ts': `
interface HasId {
  id: string;
}

class Repository<T extends HasId> {
  private store: Map<string, T> = new Map();

  save(entity: T): void {
    this.store.set(entity.id, entity);
  }

  findById(id: string): T | undefined {
    return this.store.get(id);
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const classNode = allNodes.find(n =>
        n.name === 'Repository' && n.type === 'CLASS'
      );

      assert.ok(classNode, 'CLASS "Repository<T extends HasId>" should be extracted');
      assert.strictEqual(classNode.name, 'Repository', 'Name should be "Repository" without generics');
    });

    it('should extract class with TypeScript decorators', async () => {
      await setupTest(backend, {
        'index.ts': `
function Injectable() {
  return function(target: any) {
    return target;
  };
}

@Injectable()
class ServiceProvider {
  provide(): unknown {
    return {};
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const classNode = allNodes.find(n =>
        n.name === 'ServiceProvider' && n.type === 'CLASS'
      );

      assert.ok(classNode, 'Decorated class "ServiceProvider" should be extracted');
    });

    it('should extract class with TypeScript enum and type usage', async () => {
      await setupTest(backend, {
        'index.ts': `
enum Status {
  Active = 'active',
  Inactive = 'inactive'
}

type Options = {
  timeout: number;
  retries: number;
};

class Worker {
  status: Status = Status.Active;
  private options: Options;

  constructor(options: Options) {
    this.options = options;
  }
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const classNode = allNodes.find(n =>
        n.name === 'Worker' && n.type === 'CLASS'
      );

      assert.ok(classNode, 'CLASS "Worker" should be extracted alongside enum/type declarations');
    });
  });
});
