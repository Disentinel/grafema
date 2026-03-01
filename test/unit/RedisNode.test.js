/**
 * RedisNode Unit Tests
 *
 * Tests for RedisNode creation, validation, and type checking.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { NodeFactory } from '@grafema/core';
import { isSideEffectType, NAMESPACED_TYPE } from '@grafema/types';

describe('RedisNode', () => {

  describe('Node Type Constants', () => {
    it('should have redis:* types in NAMESPACED_TYPE', () => {
      assert.strictEqual(NAMESPACED_TYPE.REDIS_READ, 'redis:read');
      assert.strictEqual(NAMESPACED_TYPE.REDIS_WRITE, 'redis:write');
      assert.strictEqual(NAMESPACED_TYPE.REDIS_DELETE, 'redis:delete');
      assert.strictEqual(NAMESPACED_TYPE.REDIS_PUBLISH, 'redis:publish');
      assert.strictEqual(NAMESPACED_TYPE.REDIS_SUBSCRIBE, 'redis:subscribe');
      assert.strictEqual(NAMESPACED_TYPE.REDIS_TRANSACTION, 'redis:transaction');
      assert.strictEqual(NAMESPACED_TYPE.REDIS_CONNECTION, 'redis:connection');
    });

    it('should classify redis:* as side effect types', () => {
      assert.strictEqual(isSideEffectType('redis:read'), true);
      assert.strictEqual(isSideEffectType('redis:write'), true);
      assert.strictEqual(isSideEffectType('redis:delete'), true);
      assert.strictEqual(isSideEffectType('redis:publish'), true);
      assert.strictEqual(isSideEffectType('redis:subscribe'), true);
    });
  });

  describe('createRedisOperation', () => {
    it('should create a redis:write node', () => {
      const node = NodeFactory.createRedisOperation(
        'src/cache.js', 'set', 15, 'redis:write', 'write',
        { column: 4, object: 'redis', key: 'user:123', package: 'ioredis' }
      );

      assert.strictEqual(node.id, 'src/cache.js:REDIS_OP:set:15');
      assert.strictEqual(node.type, 'redis:write');
      assert.strictEqual(node.name, 'redis.set');
      assert.strictEqual(node.file, 'src/cache.js');
      assert.strictEqual(node.line, 15);
      assert.strictEqual(node.column, 4);
      assert.strictEqual(node.method, 'set');
      assert.strictEqual(node.object, 'redis');
      assert.strictEqual(node.key, 'user:123');
      assert.strictEqual(node.operation, 'write');
      assert.strictEqual(node.package, 'ioredis');
    });

    it('should create a redis:read node', () => {
      const node = NodeFactory.createRedisOperation(
        'src/cache.js', 'get', 20, 'redis:read', 'read',
        { object: 'client', key: 'session:abc' }
      );

      assert.strictEqual(node.type, 'redis:read');
      assert.strictEqual(node.name, 'client.get');
      assert.strictEqual(node.operation, 'read');
    });

    it('should default package to ioredis', () => {
      const node = NodeFactory.createRedisOperation(
        'src/cache.js', 'del', 30, 'redis:delete', 'delete'
      );

      assert.strictEqual(node.package, 'ioredis');
    });

    it('should default name to redis.<method> without object', () => {
      const node = NodeFactory.createRedisOperation(
        'src/cache.js', 'hset', 10, 'redis:write', 'write'
      );

      assert.strictEqual(node.name, 'redis.hset');
    });
  });

  describe('Validation', () => {
    it('should validate redis:* nodes without errors', () => {
      const node = NodeFactory.createRedisOperation(
        'src/cache.js', 'set', 15, 'redis:write', 'write'
      );

      const errors = NodeFactory.validate(node);
      assert.deepStrictEqual(errors, []);
    });

    it('should validate all redis:* types', () => {
      const types = [
        'redis:read', 'redis:write', 'redis:delete',
        'redis:publish', 'redis:subscribe',
        'redis:transaction', 'redis:connection',
      ];

      for (const type of types) {
        const node = NodeFactory.createRedisOperation(
          'src/cache.js', 'test', 1, type, 'test'
        );
        const errors = NodeFactory.validate(node);
        assert.deepStrictEqual(errors, [], `Validation failed for type: ${type}`);
      }
    });
  });
});
