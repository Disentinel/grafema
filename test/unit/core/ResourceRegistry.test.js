import { describe, it } from 'node:test';
import assert from 'node:assert';
import { ResourceRegistryImpl } from '@grafema/core';

describe('ResourceRegistryImpl', () => {
  describe('getOrCreate', () => {
    it('should create a resource using factory on first access', () => {
      const registry = new ResourceRegistryImpl();
      const resource = registry.getOrCreate('test:resource', () => ({
        id: 'test:resource',
        data: 42,
      }));

      assert.strictEqual(resource.id, 'test:resource');
      assert.strictEqual(resource.data, 42);
    });

    it('should return existing resource on subsequent access (factory ignored)', () => {
      const registry = new ResourceRegistryImpl();
      const first = registry.getOrCreate('test:resource', () => ({
        id: 'test:resource',
        data: 'first',
      }));

      const second = registry.getOrCreate('test:resource', () => ({
        id: 'test:resource',
        data: 'second',
      }));

      assert.strictEqual(first, second);
      assert.strictEqual(second.data, 'first');
    });

    it('should throw if factory returns resource with wrong id', () => {
      const registry = new ResourceRegistryImpl();

      assert.throws(
        () => registry.getOrCreate('expected:id', () => ({
          id: 'wrong:id',
        })),
        /Resource factory returned resource with id "wrong:id" but expected "expected:id"/
      );
    });

    it('should handle multiple resources with different ids', () => {
      const registry = new ResourceRegistryImpl();

      const a = registry.getOrCreate('res:a', () => ({ id: 'res:a', value: 'alpha' }));
      const b = registry.getOrCreate('res:b', () => ({ id: 'res:b', value: 'beta' }));

      assert.strictEqual(a.value, 'alpha');
      assert.strictEqual(b.value, 'beta');
      assert.notStrictEqual(a, b);
    });
  });

  describe('get', () => {
    it('should return undefined for non-existent resource', () => {
      const registry = new ResourceRegistryImpl();
      assert.strictEqual(registry.get('nonexistent'), undefined);
    });

    it('should return resource after it was created via getOrCreate', () => {
      const registry = new ResourceRegistryImpl();
      const created = registry.getOrCreate('test:res', () => ({ id: 'test:res', x: 1 }));
      const retrieved = registry.get('test:res');

      assert.strictEqual(created, retrieved);
    });
  });

  describe('has', () => {
    it('should return false for non-existent resource', () => {
      const registry = new ResourceRegistryImpl();
      assert.strictEqual(registry.has('nonexistent'), false);
    });

    it('should return true for existing resource', () => {
      const registry = new ResourceRegistryImpl();
      registry.getOrCreate('test:res', () => ({ id: 'test:res' }));
      assert.strictEqual(registry.has('test:res'), true);
    });
  });

  describe('clear', () => {
    it('should remove all resources', () => {
      const registry = new ResourceRegistryImpl();
      registry.getOrCreate('res:a', () => ({ id: 'res:a' }));
      registry.getOrCreate('res:b', () => ({ id: 'res:b' }));

      assert.strictEqual(registry.has('res:a'), true);
      assert.strictEqual(registry.has('res:b'), true);

      registry.clear();

      assert.strictEqual(registry.has('res:a'), false);
      assert.strictEqual(registry.has('res:b'), false);
      assert.strictEqual(registry.get('res:a'), undefined);
    });

    it('should allow re-creation after clear', () => {
      const registry = new ResourceRegistryImpl();
      const first = registry.getOrCreate('test:res', () => ({ id: 'test:res', v: 1 }));
      registry.clear();
      const second = registry.getOrCreate('test:res', () => ({ id: 'test:res', v: 2 }));

      assert.notStrictEqual(first, second);
      assert.strictEqual(second.v, 2);
    });
  });
});
