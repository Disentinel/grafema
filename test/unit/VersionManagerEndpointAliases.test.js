/**
 * VersionManager endpoint-type alias TDD tests (issue #389)
 *
 * ЦЕЛЬ: stable-ID и comparison-key generation должны трактовать namespaced
 * endpoint-типы (db:query, http:request, fs:operation, net:request, net:stdio)
 * идентично их legacy-эквивалентам (DATABASE_QUERY, HTTP_REQUEST, FILESYSTEM,
 * NETWORK) — одинаковая identity/diff семантика независимо от написания.
 *
 * REGRESSION (issue #389): namespaced endpoint nodes падали в default-ветку
 * generateStableId (ключ по name:file:line), поэтому две db:query ноды с
 * одинаковым name, но разным query, коллизировали на один stable ID. И
 * _getComparisonKeys возвращал только common keys, теряя изменения query/url.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { VersionManager } from '@grafema/util';

describe('VersionManager endpoint-type aliases (issue #389)', () => {
  const vm = new VersionManager();

  it('content-hashes namespaced db:query nodes (same name, different query => distinct stable IDs)', () => {
    const a = { type: 'db:query', name: 'query', file: 'a.js', line: 1, column: 0, query: 'SELECT * FROM orders WHERE id = ?' };
    const b = { type: 'db:query', name: 'query', file: 'a.js', line: 1, column: 0, query: 'SELECT * FROM users WHERE id = ?' };

    const idA = vm.generateStableId(a);
    const idB = vm.generateStableId(b);

    assert.notStrictEqual(idA, idB, 'two db:query nodes with the same name but different query must get distinct stable IDs');
  });

  it('treats db:query ≡ DATABASE_QUERY (same query content => identical stable ID)', () => {
    const query = 'SELECT * FROM orders WHERE id = ?';
    const namespaced = { type: 'db:query', name: 'q', file: 'a.js', line: 1, column: 0, query };
    const legacy = { type: 'DATABASE_QUERY', name: 'q', file: 'a.js', line: 1, column: 0, query };

    assert.strictEqual(
      vm.generateStableId(namespaced),
      vm.generateStableId(legacy),
      'db:query and DATABASE_QUERY with identical content must produce identical stable IDs'
    );
  });

  it('content-hashes namespaced http:request nodes by url (different url => distinct stable IDs)', () => {
    const a = { type: 'http:request', name: 'fetch', file: 'a.js', line: 2, column: 0, url: 'https://api.example.com/v1/orders' };
    const b = { type: 'http:request', name: 'fetch', file: 'a.js', line: 2, column: 0, url: 'https://api.example.com/v1/users' };

    assert.notStrictEqual(vm.generateStableId(a), vm.generateStableId(b));
  });

  it('detects structural change in query for namespaced db:query via comparison keys', () => {
    const oldNode = { type: 'db:query', name: 'query', line: 1, column: 0, query: 'SELECT 1', operation: 'select', collection: 'orders' };
    const newNode = { type: 'db:query', name: 'query', line: 1, column: 0, query: 'SELECT 2', operation: 'select', collection: 'orders' };

    assert.strictEqual(
      vm.hasStructuralChanges(oldNode, newNode),
      true,
      'changing query of a db:query node must be detected as a structural change'
    );
  });

  it('detects structural change in url/method for namespaced http:request via comparison keys', () => {
    const oldNode = { type: 'http:request', name: 'req', line: 1, column: 0, method: 'GET', url: '/a', endpoint: '/a' };
    const newNode = { type: 'http:request', name: 'req', line: 1, column: 0, method: 'POST', url: '/a', endpoint: '/a' };

    assert.strictEqual(vm.hasStructuralChanges(oldNode, newNode), true);
  });
});
