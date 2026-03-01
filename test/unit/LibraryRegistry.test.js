/**
 * LibraryRegistry Unit Tests
 *
 * Tests for the LibraryRegistry class that manages npm library definitions.
 * Verifies lookup, alias resolution, and ioredis method coverage.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { LibraryRegistry } from '@grafema/core';

describe('LibraryRegistry', () => {

  describe('Library Recognition', () => {
    it('should recognize ioredis as a known library', () => {
      const registry = new LibraryRegistry();
      assert.strictEqual(registry.isKnownLibrary('ioredis'), true);
    });

    it('should recognize redis as an alias for ioredis', () => {
      const registry = new LibraryRegistry();
      assert.strictEqual(registry.isKnownLibrary('redis'), true);
    });

    it('should NOT recognize unknown packages', () => {
      const registry = new LibraryRegistry();
      assert.strictEqual(registry.isKnownLibrary('lodash'), false);
      assert.strictEqual(registry.isKnownLibrary('axios'), false);
    });
  });

  describe('Library Lookup', () => {
    it('should return library definition by canonical name', () => {
      const registry = new LibraryRegistry();
      const lib = registry.getLibrary('ioredis');
      assert.ok(lib);
      assert.strictEqual(lib.name, 'ioredis');
      assert.strictEqual(lib.category, 'cache');
      assert.ok(lib.functions.length > 0);
    });

    it('should return library definition by alias', () => {
      const registry = new LibraryRegistry();
      const lib = registry.getLibrary('redis');
      assert.ok(lib);
      assert.strictEqual(lib.name, 'ioredis');
    });

    it('should return null for unknown library', () => {
      const registry = new LibraryRegistry();
      assert.strictEqual(registry.getLibrary('unknown'), null);
    });
  });

  describe('Function Lookup', () => {
    it('should find ioredis.set as a write operation', () => {
      const registry = new LibraryRegistry();
      const func = registry.getFunction('ioredis', 'set');
      assert.ok(func);
      assert.strictEqual(func.name, 'set');
      assert.strictEqual(func.operation, 'write');
      assert.strictEqual(func.nodeType, 'redis:write');
      assert.strictEqual(func.sideEffect, true);
      assert.strictEqual(func.keyArgIndex, 0);
    });

    it('should find ioredis.get as a read operation', () => {
      const registry = new LibraryRegistry();
      const func = registry.getFunction('ioredis', 'get');
      assert.ok(func);
      assert.strictEqual(func.operation, 'read');
      assert.strictEqual(func.nodeType, 'redis:read');
      assert.strictEqual(func.keyArgIndex, 0);
    });

    it('should find ioredis.del as a delete operation', () => {
      const registry = new LibraryRegistry();
      const func = registry.getFunction('ioredis', 'del');
      assert.ok(func);
      assert.strictEqual(func.operation, 'delete');
      assert.strictEqual(func.nodeType, 'redis:delete');
    });

    it('should find ioredis.publish as a publish operation', () => {
      const registry = new LibraryRegistry();
      const func = registry.getFunction('ioredis', 'publish');
      assert.ok(func);
      assert.strictEqual(func.operation, 'publish');
      assert.strictEqual(func.nodeType, 'redis:publish');
    });

    it('should find ioredis.subscribe as a subscribe operation', () => {
      const registry = new LibraryRegistry();
      const func = registry.getFunction('ioredis', 'subscribe');
      assert.ok(func);
      assert.strictEqual(func.operation, 'subscribe');
      assert.strictEqual(func.nodeType, 'redis:subscribe');
    });

    it('should find functions via alias (redis.set)', () => {
      const registry = new LibraryRegistry();
      const func = registry.getFunction('redis', 'set');
      assert.ok(func);
      assert.strictEqual(func.name, 'set');
      assert.strictEqual(func.nodeType, 'redis:write');
    });

    it('should return null for unknown method', () => {
      const registry = new LibraryRegistry();
      assert.strictEqual(registry.getFunction('ioredis', 'nonExistent'), null);
    });

    it('should return null for unknown package', () => {
      const registry = new LibraryRegistry();
      assert.strictEqual(registry.getFunction('lodash', 'map'), null);
    });
  });

  describe('ioredis Method Coverage', () => {
    it('should have hash operations', () => {
      const registry = new LibraryRegistry();
      assert.ok(registry.getFunction('ioredis', 'hset'));
      assert.ok(registry.getFunction('ioredis', 'hget'));
      assert.ok(registry.getFunction('ioredis', 'hgetall'));
      assert.ok(registry.getFunction('ioredis', 'hdel'));
    });

    it('should have list operations', () => {
      const registry = new LibraryRegistry();
      assert.ok(registry.getFunction('ioredis', 'lpush'));
      assert.ok(registry.getFunction('ioredis', 'rpush'));
      assert.ok(registry.getFunction('ioredis', 'lrange'));
      assert.ok(registry.getFunction('ioredis', 'lpop'));
    });

    it('should have set operations', () => {
      const registry = new LibraryRegistry();
      assert.ok(registry.getFunction('ioredis', 'sadd'));
      assert.ok(registry.getFunction('ioredis', 'smembers'));
      assert.ok(registry.getFunction('ioredis', 'srem'));
    });

    it('should have sorted set operations', () => {
      const registry = new LibraryRegistry();
      assert.ok(registry.getFunction('ioredis', 'zadd'));
      assert.ok(registry.getFunction('ioredis', 'zrange'));
      assert.ok(registry.getFunction('ioredis', 'zrem'));
    });

    it('should have transaction operations', () => {
      const registry = new LibraryRegistry();
      const multi = registry.getFunction('ioredis', 'multi');
      assert.ok(multi);
      assert.strictEqual(multi.sideEffect, false);
      assert.strictEqual(multi.operation, 'transaction');

      const exec = registry.getFunction('ioredis', 'exec');
      assert.ok(exec);
      assert.strictEqual(exec.sideEffect, true);
    });

    it('should have connection operations', () => {
      const registry = new LibraryRegistry();
      const connect = registry.getFunction('ioredis', 'connect');
      assert.ok(connect);
      assert.strictEqual(connect.sideEffect, false);
      assert.strictEqual(connect.operation, 'connection');

      assert.ok(registry.getFunction('ioredis', 'disconnect'));
      assert.ok(registry.getFunction('ioredis', 'quit'));
    });

    it('should have stream operations', () => {
      const registry = new LibraryRegistry();
      assert.ok(registry.getFunction('ioredis', 'xadd'));
      assert.ok(registry.getFunction('ioredis', 'xrange'));
      assert.ok(registry.getFunction('ioredis', 'xlen'));
    });

    it('should classify incr/decr as write (they mutate)', () => {
      const registry = new LibraryRegistry();
      const incr = registry.getFunction('ioredis', 'incr');
      assert.ok(incr);
      assert.strictEqual(incr.operation, 'write');
      assert.strictEqual(incr.nodeType, 'redis:write');
    });

    it('should classify lpop/rpop as delete (element removed)', () => {
      const registry = new LibraryRegistry();
      const lpop = registry.getFunction('ioredis', 'lpop');
      assert.ok(lpop);
      assert.strictEqual(lpop.operation, 'delete');
    });
  });

  describe('registerLibrary', () => {
    it('should allow registering custom libraries', () => {
      const registry = new LibraryRegistry([]);
      assert.strictEqual(registry.isKnownLibrary('custom-cache'), false);

      registry.registerLibrary({
        name: 'custom-cache',
        aliases: ['cc'],
        category: 'cache',
        functions: [{
          name: 'put',
          package: 'custom-cache',
          operation: 'write',
          sideEffect: true,
          keyArgIndex: 0,
          nodeType: 'cache:write',
          description: 'Write to cache',
        }],
      });

      assert.strictEqual(registry.isKnownLibrary('custom-cache'), true);
      assert.strictEqual(registry.isKnownLibrary('cc'), true);
      const func = registry.getFunction('custom-cache', 'put');
      assert.ok(func);
      assert.strictEqual(func.nodeType, 'cache:write');
    });
  });

  describe('listLibraries', () => {
    it('should list canonical library names', () => {
      const registry = new LibraryRegistry();
      const libs = registry.listLibraries();
      assert.ok(libs.includes('ioredis'));
      assert.ok(!libs.includes('redis'), 'Should not include aliases');
    });
  });
});
