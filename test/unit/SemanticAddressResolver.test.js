/**
 * SemanticAddressResolver Tests (REG-627)
 *
 * Tests semantic address parsing and resolution:
 * - parseSemanticAddress: parses file:name:TYPE format
 * - SemanticAddressResolver: lazy, cached resolution to code graph node IDs
 * - Generation-based cache invalidation
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

const { parseSemanticAddress, SemanticAddressResolver } = await import('@grafema/util');

// --- Mock backend ---

function createMockBackend(nodes = []) {
  let callCount = 0;
  return {
    nodes,
    getCallCount() { return callCount; },
    async getAllNodes(filter) {
      callCount++;
      return nodes.filter(n => {
        if (filter?.file && n.file !== filter.file) return false;
        if (filter?.name && n.name !== filter.name) return false;
        if (filter?.nodeType && n.nodeType !== filter.nodeType) return false;
        return true;
      });
    },
  };
}

// --- parseSemanticAddress ---

describe('parseSemanticAddress (REG-627)', () => {
  it('should parse 3-part address: file:name:TYPE', () => {
    const result = parseSemanticAddress('src/auth.js:hashPassword:FUNCTION');
    assert.deepStrictEqual(result, {
      file: 'src/auth.js',
      name: 'hashPassword',
      type: 'FUNCTION',
      scopePath: [],
    });
  });

  it('should parse 4-part address: file:scope:name:TYPE', () => {
    const result = parseSemanticAddress('src/auth.js:AuthService:hashPassword:FUNCTION');
    assert.deepStrictEqual(result, {
      file: 'src/auth.js',
      name: 'hashPassword',
      type: 'FUNCTION',
      scopePath: ['AuthService'],
    });
  });

  it('should parse 5-part address: file:scope1:scope2:name:TYPE', () => {
    const result = parseSemanticAddress('src/auth.js:AuthModule:AuthService:hashPassword:FUNCTION');
    assert.deepStrictEqual(result, {
      file: 'src/auth.js',
      name: 'hashPassword',
      type: 'FUNCTION',
      scopePath: ['AuthModule', 'AuthService'],
    });
  });

  it('should return null for invalid formats', () => {
    assert.strictEqual(parseSemanticAddress(''), null);
    assert.strictEqual(parseSemanticAddress('just-a-string'), null);
    assert.strictEqual(parseSemanticAddress('no-dots-or-slashes:name:TYPE'), null);
    assert.strictEqual(parseSemanticAddress('file.js:name'), null); // only 2 parts
    assert.strictEqual(parseSemanticAddress('file.js:name:lowercase'), null); // type must be uppercase
  });

  it('should return null for non-string input', () => {
    assert.strictEqual(parseSemanticAddress(null), null);
    assert.strictEqual(parseSemanticAddress(undefined), null);
    assert.strictEqual(parseSemanticAddress(42), null);
  });

  it('should handle various node types', () => {
    assert.strictEqual(parseSemanticAddress('src/db.ts:Pool:CLASS').type, 'CLASS');
    assert.strictEqual(parseSemanticAddress('src/config.ts:API_KEY:VARIABLE').type, 'VARIABLE');
    assert.strictEqual(parseSemanticAddress('src/index.ts:app:MODULE').type, 'MODULE');
  });
});

// --- SemanticAddressResolver ---

describe('SemanticAddressResolver (REG-627)', () => {
  it('should resolve single match', async () => {
    const backend = createMockBackend([
      { id: 'node-1', file: 'src/auth.js', name: 'hashPassword', nodeType: 'FUNCTION' },
    ]);
    const resolver = new SemanticAddressResolver(backend);

    const result = await resolver.resolve('src/auth.js:hashPassword:FUNCTION');
    assert.strictEqual(result.status, 'resolved');
    assert.strictEqual(result.codeNodeId, 'node-1');
    assert.strictEqual(result.address, 'src/auth.js:hashPassword:FUNCTION');
  });

  it('should return dangling for zero matches', async () => {
    const backend = createMockBackend([]);
    const resolver = new SemanticAddressResolver(backend);

    const result = await resolver.resolve('src/gone.js:deletedFunc:FUNCTION');
    assert.strictEqual(result.status, 'dangling');
    assert.strictEqual(result.codeNodeId, null);
  });

  it('should disambiguate by scope path with multiple matches', async () => {
    const backend = createMockBackend([
      { id: 'node-a', file: 'src/auth.js', name: 'validate', nodeType: 'FUNCTION', scopePath: ['AuthService'] },
      { id: 'node-b', file: 'src/auth.js', name: 'validate', nodeType: 'FUNCTION', scopePath: ['TokenService'] },
    ]);
    const resolver = new SemanticAddressResolver(backend);

    const result = await resolver.resolve('src/auth.js:TokenService:validate:FUNCTION');
    assert.strictEqual(result.status, 'resolved');
    assert.strictEqual(result.codeNodeId, 'node-b');
  });

  it('should pass through kb: addresses without backend query', async () => {
    const backend = createMockBackend([]);
    const resolver = new SemanticAddressResolver(backend);

    const result = await resolver.resolve('kb:decision:some-decision');
    assert.strictEqual(result.status, 'resolved');
    assert.strictEqual(result.codeNodeId, null);
    assert.strictEqual(backend.getCallCount(), 0);
  });

  it('should cache results — second resolve does not query backend', async () => {
    const backend = createMockBackend([
      { id: 'node-1', file: 'src/auth.js', name: 'hashPassword', nodeType: 'FUNCTION' },
    ]);
    const resolver = new SemanticAddressResolver(backend);

    await resolver.resolve('src/auth.js:hashPassword:FUNCTION');
    assert.strictEqual(backend.getCallCount(), 1);

    await resolver.resolve('src/auth.js:hashPassword:FUNCTION');
    assert.strictEqual(backend.getCallCount(), 1); // still 1 — cache hit
  });

  it('should re-resolve after generation bump', async () => {
    const backend = createMockBackend([
      { id: 'node-1', file: 'src/auth.js', name: 'hashPassword', nodeType: 'FUNCTION' },
    ]);
    const resolver = new SemanticAddressResolver(backend);

    await resolver.resolve('src/auth.js:hashPassword:FUNCTION');
    assert.strictEqual(backend.getCallCount(), 1);

    resolver.bumpGeneration();
    await resolver.resolve('src/auth.js:hashPassword:FUNCTION');
    assert.strictEqual(backend.getCallCount(), 2); // re-resolved
  });

  it('should return dangling addresses via getDanglingAddresses', async () => {
    const backend = createMockBackend([
      { id: 'node-1', file: 'src/auth.js', name: 'hashPassword', nodeType: 'FUNCTION' },
    ]);
    const resolver = new SemanticAddressResolver(backend);

    await resolver.resolve('src/auth.js:hashPassword:FUNCTION'); // resolved
    await resolver.resolve('src/gone.js:deleted:FUNCTION'); // dangling

    const dangling = resolver.getDanglingAddresses();
    assert.strictEqual(dangling.length, 1);
    assert.strictEqual(dangling[0].address, 'src/gone.js:deleted:FUNCTION');
    assert.strictEqual(dangling[0].status, 'dangling');
  });

  it('should handle resolveAll for multiple addresses', async () => {
    const backend = createMockBackend([
      { id: 'node-1', file: 'src/auth.js', name: 'hashPassword', nodeType: 'FUNCTION' },
    ]);
    const resolver = new SemanticAddressResolver(backend);

    const results = await resolver.resolveAll([
      'src/auth.js:hashPassword:FUNCTION',
      'src/gone.js:deleted:FUNCTION',
      'kb:fact:internal-ref',
    ]);

    assert.strictEqual(results.length, 3);
    assert.strictEqual(results[0].status, 'resolved');
    assert.strictEqual(results[1].status, 'dangling');
    assert.strictEqual(results[2].status, 'resolved'); // kb: passthrough
  });

  it('should return dangling for unparseable address', async () => {
    const backend = createMockBackend([]);
    const resolver = new SemanticAddressResolver(backend);

    const result = await resolver.resolve('not-a-valid-address');
    assert.strictEqual(result.status, 'dangling');
    assert.strictEqual(result.codeNodeId, null);
    assert.strictEqual(backend.getCallCount(), 0); // no query for unparseable
  });

  it('should pick first match when scope disambiguation fails', async () => {
    const backend = createMockBackend([
      { id: 'node-a', file: 'src/auth.js', name: 'validate', nodeType: 'FUNCTION' },
      { id: 'node-b', file: 'src/auth.js', name: 'validate', nodeType: 'FUNCTION' },
    ]);
    const resolver = new SemanticAddressResolver(backend);

    // No scope in address, multiple matches — takes first
    const result = await resolver.resolve('src/auth.js:validate:FUNCTION');
    assert.strictEqual(result.status, 'resolved');
    assert.strictEqual(result.codeNodeId, 'node-a');
  });
});
