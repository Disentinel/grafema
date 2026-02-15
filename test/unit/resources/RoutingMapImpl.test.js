import { describe, it } from 'node:test';
import assert from 'node:assert';
import { RoutingMapImpl, createRoutingMap } from '@grafema/core';

describe('RoutingMapImpl', () => {
  describe('addRule / ruleCount', () => {
    it('should add a rule and increment count', () => {
      const map = createRoutingMap();
      assert.strictEqual(map.ruleCount, 0);

      map.addRule({ from: 'frontend', to: 'backend', stripPrefix: '/api' });
      assert.strictEqual(map.ruleCount, 1);
    });

    it('should deduplicate identical rules (same from/to/stripPrefix/addPrefix)', () => {
      const map = createRoutingMap();
      map.addRule({ from: 'frontend', to: 'backend', stripPrefix: '/api' });
      map.addRule({ from: 'frontend', to: 'backend', stripPrefix: '/api' });
      assert.strictEqual(map.ruleCount, 1);
    });

    it('should NOT deduplicate rules with different stripPrefix', () => {
      const map = createRoutingMap();
      map.addRule({ from: 'frontend', to: 'backend', stripPrefix: '/api' });
      map.addRule({ from: 'frontend', to: 'backend', stripPrefix: '/v2' });
      assert.strictEqual(map.ruleCount, 2);
    });
  });

  describe('addRules', () => {
    it('should add multiple rules at once', () => {
      const map = createRoutingMap();
      map.addRules([
        { from: 'frontend', to: 'backend', stripPrefix: '/api' },
        { from: 'frontend', to: 'auth', stripPrefix: '/auth' },
      ]);
      assert.strictEqual(map.ruleCount, 2);
    });
  });

  describe('findRulesForPair', () => {
    it('should return rules for specific from/to pair', () => {
      const map = createRoutingMap();
      map.addRule({ from: 'frontend', to: 'backend', stripPrefix: '/api' });
      map.addRule({ from: 'frontend', to: 'auth', stripPrefix: '/auth' });

      const rules = map.findRulesForPair('frontend', 'backend');
      assert.strictEqual(rules.length, 1);
      assert.strictEqual(rules[0].stripPrefix, '/api');
    });

    it('should return empty array for non-existent pair', () => {
      const map = createRoutingMap();
      map.addRule({ from: 'frontend', to: 'backend', stripPrefix: '/api' });

      const rules = map.findRulesForPair('admin', 'backend');
      assert.strictEqual(rules.length, 0);
    });
  });

  describe('findMatch', () => {
    describe('stripPrefix', () => {
      it('should strip prefix and return transformed URL', () => {
        const map = createRoutingMap();
        map.addRule({ from: 'frontend', to: 'backend', stripPrefix: '/api' });

        const match = map.findMatch({
          fromService: 'frontend',
          requestUrl: '/api/users',
        });

        assert.ok(match);
        assert.strictEqual(match.transformedUrl, '/users');
        assert.strictEqual(match.targetService, 'backend');
      });

      it('should return null if prefix does not match', () => {
        const map = createRoutingMap();
        map.addRule({ from: 'frontend', to: 'backend', stripPrefix: '/api' });

        const match = map.findMatch({
          fromService: 'frontend',
          requestUrl: '/auth/login',
        });

        assert.strictEqual(match, null);
      });

      it('should not strip partial prefix match (/api should not strip /api-v2)', () => {
        const map = createRoutingMap();
        map.addRule({ from: 'frontend', to: 'backend', stripPrefix: '/api' });

        const match = map.findMatch({
          fromService: 'frontend',
          requestUrl: '/api-v2/users',
        });

        assert.strictEqual(match, null);
      });

      it('should handle stripPrefix resulting in root /', () => {
        const map = createRoutingMap();
        map.addRule({ from: 'frontend', to: 'backend', stripPrefix: '/api' });

        const match = map.findMatch({
          fromService: 'frontend',
          requestUrl: '/api',
        });

        assert.ok(match);
        assert.strictEqual(match.transformedUrl, '/');
      });
    });

    describe('addPrefix', () => {
      it('should add prefix to URL', () => {
        const map = createRoutingMap();
        map.addRule({ from: 'frontend', to: 'backend', addPrefix: '/v2' });

        const match = map.findMatch({
          fromService: 'frontend',
          requestUrl: '/users',
        });

        assert.ok(match);
        assert.strictEqual(match.transformedUrl, '/v2/users');
      });

      it('should handle double-slash prevention', () => {
        const map = createRoutingMap();
        map.addRule({ from: 'frontend', to: 'backend', addPrefix: '/v2/' });

        const match = map.findMatch({
          fromService: 'frontend',
          requestUrl: '/users',
        });

        assert.ok(match);
        assert.strictEqual(match.transformedUrl, '/v2/users');
      });
    });

    describe('combined stripPrefix + addPrefix', () => {
      it('should strip then add prefix', () => {
        const map = createRoutingMap();
        map.addRule({
          from: 'frontend',
          to: 'backend',
          stripPrefix: '/v2',
          addPrefix: '/api',
        });

        const match = map.findMatch({
          fromService: 'frontend',
          requestUrl: '/v2/users',
        });

        assert.ok(match);
        assert.strictEqual(match.transformedUrl, '/api/users');
      });
    });

    describe('priority', () => {
      it('should prefer longer stripPrefix over shorter', () => {
        const map = createRoutingMap();
        map.addRule({ from: 'frontend', to: 'backend', stripPrefix: '/api' });
        map.addRule({ from: 'frontend', to: 'backend', stripPrefix: '/api/v1' });

        const match = map.findMatch({
          fromService: 'frontend',
          requestUrl: '/api/v1/users',
        });

        assert.ok(match);
        assert.strictEqual(match.transformedUrl, '/users');
        assert.strictEqual(match.rule.stripPrefix, '/api/v1');
      });

      it('should prefer lower priority number when stripPrefix length is equal', () => {
        const map = createRoutingMap();
        map.addRule({ from: 'frontend', to: 'svc-a', stripPrefix: '/api', priority: 10 });
        map.addRule({ from: 'frontend', to: 'svc-b', stripPrefix: '/api', priority: 1 });

        const match = map.findMatch({
          fromService: 'frontend',
          requestUrl: '/api/users',
        });

        assert.ok(match);
        assert.strictEqual(match.targetService, 'svc-b');
      });
    });

    describe('no routing rules', () => {
      it('should return null when no rules exist', () => {
        const map = createRoutingMap();
        const match = map.findMatch({
          fromService: 'frontend',
          requestUrl: '/users',
        });
        assert.strictEqual(match, null);
      });

      it('should return null when no rules match the fromService', () => {
        const map = createRoutingMap();
        map.addRule({ from: 'admin', to: 'backend', stripPrefix: '/api' });

        const match = map.findMatch({
          fromService: 'frontend',
          requestUrl: '/api/users',
        });

        assert.strictEqual(match, null);
      });
    });
  });

  describe('getAllRules', () => {
    it('should return copy of all rules', () => {
      const map = createRoutingMap();
      map.addRule({ from: 'a', to: 'b', stripPrefix: '/x' });
      map.addRule({ from: 'c', to: 'd', stripPrefix: '/y' });

      const all = map.getAllRules();
      assert.strictEqual(all.length, 2);

      // Verify it's a copy
      all.push({ from: 'e', to: 'f' });
      assert.strictEqual(map.ruleCount, 2);
    });
  });

  describe('multiple service pairs', () => {
    it('should handle rules for different service pairs independently', () => {
      const map = createRoutingMap();
      map.addRule({ from: 'frontend', to: 'backend', stripPrefix: '/api' });
      map.addRule({ from: 'frontend', to: 'auth', stripPrefix: '/auth' });
      map.addRule({ from: 'admin', to: 'backend', stripPrefix: '/backend' });

      const frontendBackend = map.findMatch({
        fromService: 'frontend',
        requestUrl: '/api/users',
      });
      assert.ok(frontendBackend);
      assert.strictEqual(frontendBackend.targetService, 'backend');
      assert.strictEqual(frontendBackend.transformedUrl, '/users');

      const frontendAuth = map.findMatch({
        fromService: 'frontend',
        requestUrl: '/auth/login',
      });
      assert.ok(frontendAuth);
      assert.strictEqual(frontendAuth.targetService, 'auth');
      assert.strictEqual(frontendAuth.transformedUrl, '/login');

      const adminBackend = map.findMatch({
        fromService: 'admin',
        requestUrl: '/backend/users',
      });
      assert.ok(adminBackend);
      assert.strictEqual(adminBackend.targetService, 'backend');
      assert.strictEqual(adminBackend.transformedUrl, '/users');
    });
  });

  describe('createRoutingMap factory', () => {
    it('should create RoutingMap with correct id', () => {
      const map = createRoutingMap();
      assert.strictEqual(map.id, 'routing:map');
    });
  });
});
