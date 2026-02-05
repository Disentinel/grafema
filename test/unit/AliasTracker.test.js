/**
 * AliasTracker Tests
 *
 * Tests for alias resolution: const m = obj.method; m() → resolves to obj.method
 */

import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import { AliasTracker } from '@grafema/core';
import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';

// Cleanup all test databases after all tests complete
after(cleanupAllTestDatabases);

describe('AliasTracker', () => {
  async function setupBackend() {
    const db = await createTestDatabase();
    return { backend: db.backend, db };
  }

  describe('Basic alias resolution', () => {
    it('should find alias from MemberExpression', async () => {
      const { backend } = await setupBackend();

      try {
        const tracker = new AliasTracker();

        // Симулируем: const m = obj.method; m()
        await backend.addNodes([
          // Класс с методом
          { id: 'user-class', type: 'CLASS', name: 'User', file: 'app.js' },
          { id: 'user-save', type: 'METHOD', name: 'save', file: 'app.js' },
          // Переменная user
          { id: 'user-var', type: 'VARIABLE', name: 'user', file: 'app.js' },
          // EXPRESSION для user.save
          { id: 'expr-user-save', type: 'EXPRESSION', expressionType: 'MemberExpression', object: 'user', property: 'save', file: 'app.js' },
          // Алиас переменная m
          { id: 'alias-m', type: 'VARIABLE', name: 'm', file: 'app.js' },
          // Вызов m() - это CALL без object
          { id: 'call-m', type: 'CALL', name: 'm', file: 'app.js' }
        ]);

        // Структура:
        // User CONTAINS user-save
        // user-var INSTANCE_OF User
        // alias-m ASSIGNED_FROM expr-user-save
        // expr-user-save DERIVES_FROM user-var
        await backend.addEdge({ src: 'user-class', dst: 'user-save', type: 'CONTAINS' });
        await backend.addEdge({ src: 'user-var', dst: 'user-class', type: 'INSTANCE_OF' });
        await backend.addEdge({ src: 'alias-m', dst: 'expr-user-save', type: 'ASSIGNED_FROM' });
        await backend.addEdge({ src: 'expr-user-save', dst: 'user-var', type: 'DERIVES_FROM' });
        await backend.flush();

        const result = await tracker.execute({ graph: backend });

        // Должен найти алиас
        assert.strictEqual(result.metadata.aliasesFound, 1, 'Should find one alias');

        // Проверяем что создано ALIAS_OF ребро
        const aliasEdges = await backend.getOutgoingEdges('call-m', ['ALIAS_OF']);
        assert.strictEqual(aliasEdges.length, 1, 'Should create ALIAS_OF edge');

        // Проверяем что создано CALLS ребро к методу
        const callsEdges = await backend.getOutgoingEdges('call-m', ['CALLS']);
        assert.strictEqual(callsEdges.length, 1, 'Should create CALLS edge');

        const targetNode = await backend.getNode(callsEdges[0].dst);
        assert.strictEqual(targetNode.name, 'save', 'Should resolve to save method');

        console.log('Basic alias resolution works');
      } finally {
        await backend.close();
      }
    });

    it('should handle const alias to class method', async () => {
      const { backend } = await setupBackend();

      try {
        const tracker = new AliasTracker();

        // const save = User.save; save()
        await backend.addNodes([
          { id: 'user-class', type: 'CLASS', name: 'User', file: 'app.js' },
          { id: 'user-save', type: 'METHOD', name: 'save', file: 'app.js' },
          { id: 'expr-save', type: 'EXPRESSION', expressionType: 'MemberExpression', object: 'User', property: 'save', file: 'app.js' },
          { id: 'const-save', type: 'CONSTANT', name: 'save', file: 'app.js' },
          { id: 'call-save', type: 'CALL', name: 'save', file: 'app.js' }
        ]);

        await backend.addEdge({ src: 'user-class', dst: 'user-save', type: 'CONTAINS' });
        await backend.addEdge({ src: 'const-save', dst: 'expr-save', type: 'ASSIGNED_FROM' });
        await backend.flush();

        const result = await tracker.execute({ graph: backend });

        assert.strictEqual(result.metadata.aliasesFound, 1, 'Should find alias');
        assert.strictEqual(result.metadata.resolvedToMethod, 1, 'Should resolve to method');

        console.log('Const alias to class method works');
      } finally {
        await backend.close();
      }
    });

    it('should skip already resolved calls', async () => {
      const { backend } = await setupBackend();

      try {
        const tracker = new AliasTracker();

        await backend.addNodes([
          { id: 'target-fn', type: 'FUNCTION', name: 'm', file: 'app.js' },
          { id: 'call-m', type: 'CALL', name: 'm', file: 'app.js' }
        ]);

        // Уже есть CALLS ребро
        await backend.addEdge({ src: 'call-m', dst: 'target-fn', type: 'CALLS' });
        await backend.flush();

        const result = await tracker.execute({ graph: backend });

        // Не должен обрабатывать уже резолвленные
        assert.strictEqual(result.metadata.callsProcessed, 0, 'Should skip resolved calls');

        console.log('Skip already resolved calls works');
      } finally {
        await backend.close();
      }
    });

    it('should skip method calls (with object)', async () => {
      const { backend } = await setupBackend();

      try {
        const tracker = new AliasTracker();

        await backend.addNodes([
          // Это METHOD_CALL (есть object) - AliasTracker не должен его трогать
          { id: 'method-call', type: 'CALL', name: 'obj.method', file: 'app.js', object: 'obj', method: 'method' }
        ]);

        await backend.flush();

        const result = await tracker.execute({ graph: backend });

        assert.strictEqual(result.metadata.callsProcessed, 0, 'Should skip method calls');

        console.log('Skip method calls works');
      } finally {
        await backend.close();
      }
    });
  });

  describe('Computed property aliases', () => {
    it('should not resolve computed property aliases', async () => {
      const { backend } = await setupBackend();

      try {
        const tracker = new AliasTracker();

        // const m = obj[key]; m() - не можем резолвить статически
        await backend.addNodes([
          { id: 'expr-computed', type: 'EXPRESSION', expressionType: 'MemberExpression', object: 'obj', property: '<computed>', computed: true, file: 'app.js' },
          { id: 'var-m', type: 'VARIABLE', name: 'm', file: 'app.js' },
          { id: 'call-m', type: 'CALL', name: 'm', file: 'app.js' }
        ]);

        await backend.addEdge({ src: 'var-m', dst: 'expr-computed', type: 'ASSIGNED_FROM' });
        await backend.flush();

        const result = await tracker.execute({ graph: backend });

        // Должен найти алиас но не резолвить
        assert.strictEqual(result.metadata.aliasesFound, 1, 'Should find alias');
        assert.strictEqual(result.metadata.resolvedToMethod, 0, 'Should not resolve computed');

        // ALIAS_OF ребро всё равно создаётся
        const aliasEdges = await backend.getOutgoingEdges('call-m', ['ALIAS_OF']);
        assert.strictEqual(aliasEdges.length, 1, 'Should still create ALIAS_OF edge');

        console.log('Computed property not resolved (as expected)');
      } finally {
        await backend.close();
      }
    });
  });

  describe('Security: aliased eval detection', () => {
    it('should track aliased eval calls', async () => {
      const { backend } = await setupBackend();

      try {
        const tracker = new AliasTracker();

        // const e = window.eval; e(code) - обход прямого запрета eval
        await backend.addNodes([
          { id: 'expr-eval', type: 'EXPRESSION', expressionType: 'MemberExpression', object: 'window', property: 'eval', file: 'app.js' },
          { id: 'var-e', type: 'VARIABLE', name: 'e', file: 'app.js' },
          { id: 'call-e', type: 'CALL', name: 'e', file: 'app.js' }
        ]);

        await backend.addEdge({ src: 'var-e', dst: 'expr-eval', type: 'ASSIGNED_FROM' });
        await backend.flush();

        const result = await tracker.execute({ graph: backend });

        assert.strictEqual(result.metadata.aliasesFound, 1, 'Should find eval alias');

        // ALIAS_OF ребро позволяет обнаружить что e это window.eval
        const aliasEdges = await backend.getOutgoingEdges('call-e', ['ALIAS_OF']);
        assert.strictEqual(aliasEdges.length, 1, 'Should create ALIAS_OF edge');

        const exprNode = await backend.getNode(aliasEdges[0].dst);
        assert.strictEqual(exprNode.object, 'window', 'Should trace to window');
        assert.strictEqual(exprNode.property, 'eval', 'Should trace to eval');

        console.log('Aliased eval detection works');
      } finally {
        await backend.close();
      }
    });
  });

  describe('Datalog integration', () => {
    it('should enable alias queries via Datalog', async () => {
      const { backend } = await setupBackend();

      try {
        const tracker = new AliasTracker();

        await backend.addNodes([
          { id: 'expr-method', type: 'EXPRESSION', expressionType: 'MemberExpression', object: 'obj', property: 'dangerous', file: 'app.js' },
          { id: 'var-m', type: 'VARIABLE', name: 'm', file: 'app.js' },
          { id: 'call-m', type: 'CALL', name: 'm', file: 'app.js' }
        ]);

        await backend.addEdge({ src: 'var-m', dst: 'expr-method', type: 'ASSIGNED_FROM' });
        await backend.flush();

        await tracker.execute({ graph: backend });

        // Datalog query: найти все вызовы которые являются алиасами
        const violations = await backend.checkGuarantee(`
          % Найти CALL который alias для чего-то
          violation(X) :- node(X, "CALL"), edge(X, _, "ALIAS_OF").
        `);

        assert.strictEqual(violations.length, 1, 'Should find aliased call via Datalog');

        console.log('Datalog alias query works');
      } finally {
        await backend.close();
      }
    });

    it('should detect aliased dangerous methods via Datalog', async () => {
      const { backend } = await setupBackend();

      try {
        const tracker = new AliasTracker();

        // const e = globalThis.eval; e(code)
        await backend.addNodes([
          { id: 'expr-eval', type: 'EXPRESSION', expressionType: 'MemberExpression', object: 'globalThis', property: 'eval', file: 'app.js' },
          { id: 'var-e', type: 'VARIABLE', name: 'e', file: 'app.js' },
          { id: 'call-e', type: 'CALL', name: 'e', file: 'app.js' }
        ]);

        await backend.addEdge({ src: 'var-e', dst: 'expr-eval', type: 'ASSIGNED_FROM' });
        await backend.flush();

        await tracker.execute({ graph: backend });

        // Datalog: найти вызовы aliased к eval
        const violations = await backend.checkGuarantee(`
          % CALL который является алиасом eval
          violation(X) :-
            node(X, "CALL"),
            edge(X, Expr, "ALIAS_OF"),
            attr(Expr, "property", "eval").
        `);

        assert.strictEqual(violations.length, 1, 'Should detect aliased eval');

        console.log('Aliased eval detection via Datalog works');
      } finally {
        await backend.close();
      }
    });
  });

  describe('Multiple aliases', () => {
    it('should handle multiple aliases in same file', async () => {
      const { backend } = await setupBackend();

      try {
        const tracker = new AliasTracker();

        await backend.addNodes([
          { id: 'class-a', type: 'CLASS', name: 'Service', file: 'app.js' },
          { id: 'method-start', type: 'METHOD', name: 'start', file: 'app.js' },
          { id: 'method-stop', type: 'METHOD', name: 'stop', file: 'app.js' },
          { id: 'expr-start', type: 'EXPRESSION', expressionType: 'MemberExpression', object: 'Service', property: 'start', file: 'app.js' },
          { id: 'expr-stop', type: 'EXPRESSION', expressionType: 'MemberExpression', object: 'Service', property: 'stop', file: 'app.js' },
          { id: 'var-s', type: 'VARIABLE', name: 's', file: 'app.js' },
          { id: 'var-t', type: 'VARIABLE', name: 't', file: 'app.js' },
          { id: 'call-s', type: 'CALL', name: 's', file: 'app.js' },
          { id: 'call-t', type: 'CALL', name: 't', file: 'app.js' }
        ]);

        await backend.addEdge({ src: 'class-a', dst: 'method-start', type: 'CONTAINS' });
        await backend.addEdge({ src: 'class-a', dst: 'method-stop', type: 'CONTAINS' });
        await backend.addEdge({ src: 'var-s', dst: 'expr-start', type: 'ASSIGNED_FROM' });
        await backend.addEdge({ src: 'var-t', dst: 'expr-stop', type: 'ASSIGNED_FROM' });
        await backend.flush();

        const result = await tracker.execute({ graph: backend });

        assert.strictEqual(result.metadata.aliasesFound, 2, 'Should find two aliases');
        assert.strictEqual(result.metadata.resolvedToMethod, 2, 'Should resolve both to methods');

        console.log('Multiple aliases in same file works');
      } finally {
        await backend.close();
      }
    });
  });

  describe('Transitive aliases (re-export chains)', () => {
    it('should resolve 2-level alias chain: a = obj.method; b = a; b()', async () => {
      const { backend } = await setupBackend();

      try {
        const tracker = new AliasTracker();

        // const m = User.save;
        // const alias = m;
        // alias();
        await backend.addNodes([
          { id: 'user-class', type: 'CLASS', name: 'User', file: 'app.js' },
          { id: 'user-save', type: 'METHOD', name: 'save', file: 'app.js' },
          { id: 'expr-save', type: 'EXPRESSION', expressionType: 'MemberExpression', object: 'User', property: 'save', file: 'app.js' },
          { id: 'var-m', type: 'VARIABLE', name: 'm', file: 'app.js' },
          { id: 'var-alias', type: 'VARIABLE', name: 'alias', file: 'app.js' },
          { id: 'call-alias', type: 'CALL', name: 'alias', file: 'app.js' }
        ]);

        // m = User.save (через EXPRESSION)
        // alias = m (через VARIABLE)
        await backend.addEdge({ src: 'user-class', dst: 'user-save', type: 'CONTAINS' });
        await backend.addEdge({ src: 'var-m', dst: 'expr-save', type: 'ASSIGNED_FROM' });
        await backend.addEdge({ src: 'var-alias', dst: 'var-m', type: 'ASSIGNED_FROM' });
        await backend.flush();

        const result = await tracker.execute({ graph: backend });

        // Должен найти транзитивный алиас
        assert.ok(result.metadata.aliasesFound >= 1, 'Should find transitive alias');

        // Проверяем CALLS ребро к методу
        const callsEdges = await backend.getOutgoingEdges('call-alias', ['CALLS']);
        assert.strictEqual(callsEdges.length, 1, 'Should create CALLS edge via transitive alias');

        const targetNode = await backend.getNode(callsEdges[0].dst);
        assert.strictEqual(targetNode.name, 'save', 'Should resolve to save method');

        console.log('2-level transitive alias works');
      } finally {
        await backend.close();
      }
    });

    it('should resolve 3-level alias chain (re-export scenario)', async () => {
      const { backend } = await setupBackend();

      try {
        const tracker = new AliasTracker();

        // Симулируем цепочку реэкспортов:
        // original.js: export const handler = Service.process
        // utils.js: export { handler } from './original' (alias: h = handler)
        // index.js: import { h } from './utils' (alias: fn = h)
        // fn()

        await backend.addNodes([
          { id: 'svc-class', type: 'CLASS', name: 'Service', file: 'service.js' },
          { id: 'svc-process', type: 'METHOD', name: 'process', file: 'service.js' },
          { id: 'expr-process', type: 'EXPRESSION', expressionType: 'MemberExpression', object: 'Service', property: 'process', file: 'original.js' },
          // Цепочка: handler <- expr <- h <- fn
          { id: 'var-handler', type: 'VARIABLE', name: 'handler', file: 'original.js' },
          { id: 'var-h', type: 'VARIABLE', name: 'h', file: 'utils.js' },
          { id: 'var-fn', type: 'VARIABLE', name: 'fn', file: 'index.js' },
          { id: 'call-fn', type: 'CALL', name: 'fn', file: 'index.js' }
        ]);

        await backend.addEdge({ src: 'svc-class', dst: 'svc-process', type: 'CONTAINS' });
        await backend.addEdge({ src: 'var-handler', dst: 'expr-process', type: 'ASSIGNED_FROM' });
        await backend.addEdge({ src: 'var-h', dst: 'var-handler', type: 'ASSIGNED_FROM' });
        await backend.addEdge({ src: 'var-fn', dst: 'var-h', type: 'ASSIGNED_FROM' });
        await backend.flush();

        const result = await tracker.execute({ graph: backend });

        // Должен резолвить через 3 уровня
        const callsEdges = await backend.getOutgoingEdges('call-fn', ['CALLS']);
        assert.strictEqual(callsEdges.length, 1, 'Should resolve 3-level chain');

        const targetNode = await backend.getNode(callsEdges[0].dst);
        assert.strictEqual(targetNode.name, 'process', 'Should resolve to process method');

        console.log('3-level transitive alias (re-export chain) works');
      } finally {
        await backend.close();
      }
    });

    it('should handle 6-level re-export chain', async () => {
      const { backend } = await setupBackend();

      try {
        const tracker = new AliasTracker();

        // 6 уровней реэкспорта - реальный сценарий в больших проектах
        await backend.addNodes([
          { id: 'db-class', type: 'CLASS', name: 'Database', file: 'db.js' },
          { id: 'db-query', type: 'METHOD', name: 'query', file: 'db.js' },
          { id: 'expr-query', type: 'EXPRESSION', expressionType: 'MemberExpression', object: 'Database', property: 'query', file: 'db.js' },
          // Цепочка из 6 переменных
          { id: 'var-1', type: 'VARIABLE', name: 'dbQuery', file: 'level1.js' },
          { id: 'var-2', type: 'VARIABLE', name: 'query', file: 'level2.js' },
          { id: 'var-3', type: 'VARIABLE', name: 'q', file: 'level3.js' },
          { id: 'var-4', type: 'VARIABLE', name: 'executeQuery', file: 'level4.js' },
          { id: 'var-5', type: 'VARIABLE', name: 'exec', file: 'level5.js' },
          { id: 'var-6', type: 'VARIABLE', name: 'run', file: 'app.js' },
          { id: 'call-run', type: 'CALL', name: 'run', file: 'app.js' }
        ]);

        await backend.addEdge({ src: 'db-class', dst: 'db-query', type: 'CONTAINS' });
        await backend.addEdge({ src: 'var-1', dst: 'expr-query', type: 'ASSIGNED_FROM' });
        await backend.addEdge({ src: 'var-2', dst: 'var-1', type: 'ASSIGNED_FROM' });
        await backend.addEdge({ src: 'var-3', dst: 'var-2', type: 'ASSIGNED_FROM' });
        await backend.addEdge({ src: 'var-4', dst: 'var-3', type: 'ASSIGNED_FROM' });
        await backend.addEdge({ src: 'var-5', dst: 'var-4', type: 'ASSIGNED_FROM' });
        await backend.addEdge({ src: 'var-6', dst: 'var-5', type: 'ASSIGNED_FROM' });
        await backend.flush();

        const result = await tracker.execute({ graph: backend });

        // Должен резолвить через все 6 уровней
        const callsEdges = await backend.getOutgoingEdges('call-run', ['CALLS']);
        assert.strictEqual(callsEdges.length, 1, 'Should resolve 6-level chain');

        const targetNode = await backend.getNode(callsEdges[0].dst);
        assert.strictEqual(targetNode.name, 'query', 'Should resolve to query method');

        console.log('6-level re-export chain works!');
      } finally {
        await backend.close();
      }
    });

    it('should detect cycle in alias chain (prevent infinite loop)', async () => {
      const { backend } = await setupBackend();

      try {
        const tracker = new AliasTracker();

        // Цикл: a = b; b = c; c = a
        await backend.addNodes([
          { id: 'var-a', type: 'VARIABLE', name: 'a', file: 'app.js' },
          { id: 'var-b', type: 'VARIABLE', name: 'b', file: 'app.js' },
          { id: 'var-c', type: 'VARIABLE', name: 'c', file: 'app.js' },
          { id: 'call-a', type: 'CALL', name: 'a', file: 'app.js' }
        ]);

        await backend.addEdge({ src: 'var-a', dst: 'var-b', type: 'ASSIGNED_FROM' });
        await backend.addEdge({ src: 'var-b', dst: 'var-c', type: 'ASSIGNED_FROM' });
        await backend.addEdge({ src: 'var-c', dst: 'var-a', type: 'ASSIGNED_FROM' }); // cycle!
        await backend.flush();

        // Не должен зависнуть
        const result = await tracker.execute({ graph: backend });

        // Не должен крашиться, просто не резолвит
        assert.ok(result, 'Should not crash on cycle');

        console.log('Cycle detection works (no infinite loop)');
      } finally {
        await backend.close();
      }
    });

    it('should warn when max depth exceeded (12-level chain)', async () => {
      const { backend } = await setupBackend();

      try {
        const tracker = new AliasTracker();

        // Создаём цепочку из 12 переменных (больше MAX_DEPTH=10)
        const nodes = [
          { id: 'db-class', type: 'CLASS', name: 'Database', file: 'db.js' },
          { id: 'db-query', type: 'METHOD', name: 'query', file: 'db.js' },
          { id: 'expr-query', type: 'EXPRESSION', expressionType: 'MemberExpression', object: 'Database', property: 'query', file: 'db.js' }
        ];

        // 12 переменных в цепочке
        for (let i = 1; i <= 12; i++) {
          nodes.push({ id: `var-${i}`, type: 'VARIABLE', name: `level${i}`, file: `level${i}.js` });
        }
        nodes.push({ id: 'call-final', type: 'CALL', name: 'level12', file: 'level12.js' });

        await backend.addNodes(nodes);

        // Связываем: var-1 -> expr, var-2 -> var-1, ..., var-12 -> var-11
        await backend.addEdge({ src: 'db-class', dst: 'db-query', type: 'CONTAINS' });
        await backend.addEdge({ src: 'var-1', dst: 'expr-query', type: 'ASSIGNED_FROM' });
        for (let i = 2; i <= 12; i++) {
          await backend.addEdge({ src: `var-${i}`, dst: `var-${i - 1}`, type: 'ASSIGNED_FROM' });
        }
        await backend.flush();

        const result = await tracker.execute({ graph: backend });

        // Должен записать превышение глубины
        assert.ok(result.metadata.depthExceeded >= 1, 'Should track depth exceeded');

        // Вызов НЕ должен быть резолвлен (цепочка слишком длинная)
        const callsEdges = await backend.getOutgoingEdges('call-final', ['CALLS']);
        assert.strictEqual(callsEdges.length, 0, 'Should NOT resolve 12-level chain (exceeds MAX_DEPTH)');

        console.log('Depth exceeded warning works!');
      } finally {
        await backend.close();
      }
    });
  });
});
