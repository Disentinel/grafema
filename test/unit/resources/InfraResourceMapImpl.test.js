/**
 * InfraResourceMapImpl Tests — REG-363: USG Phase 1
 *
 * Tests the InfraResourceMap implementation that maps concrete infrastructure
 * resources (K8s deployments, Terraform resources) to abstract types
 * (compute:service, storage:database).
 *
 * Follows the same pattern as RoutingMapImpl: register data, query by various dimensions.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { InfraResourceMapImpl, createInfraResourceMap } from '@grafema/core';

// =============================================================================
// TEST HELPERS
// =============================================================================

/**
 * Create a standard ResourceMapping for testing.
 * Defaults model a K8s Deployment → compute:service mapping.
 */
function makeMapping(overrides = {}) {
  return {
    concreteId: 'infra:k8s:deployment:user-api',
    concreteType: 'infra:k8s:deployment',
    abstractType: 'compute:service',
    abstractId: 'compute:service:user-api',
    name: 'user-api',
    metadata: { replicas: 3, image: 'user-api:v1.2.3' },
    env: 'prod',
    sourceFile: 'k8s/prod/user-api.yaml',
    sourceTool: 'kubernetes',
    ...overrides,
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('InfraResourceMapImpl', () => {
  describe('register / resourceCount', () => {
    it('should register a mapping and increment count', () => {
      const map = createInfraResourceMap();
      assert.strictEqual(map.resourceCount, 0);

      map.register(makeMapping());
      assert.strictEqual(map.resourceCount, 1);
    });

    it('should deduplicate providers (same concreteId registered twice)', () => {
      const map = createInfraResourceMap();
      map.register(makeMapping());
      map.register(makeMapping());
      assert.strictEqual(map.resourceCount, 1);

      // Should still have only one provider
      const providers = map.findConcrete('compute:service:user-api');
      assert.strictEqual(providers.length, 1);
    });

    it('should NOT deduplicate different concrete resources for same abstract', () => {
      const map = createInfraResourceMap();

      // K8s deployment provides compute:service:user-api
      map.register(makeMapping({
        concreteId: 'infra:k8s:deployment:user-api',
        sourceTool: 'kubernetes',
      }));

      // Terraform resource also provides compute:service:user-api
      map.register(makeMapping({
        concreteId: 'infra:terraform:resource:user-api',
        concreteType: 'infra:terraform:aws_ecs_service',
        sourceTool: 'terraform',
        sourceFile: 'terraform/main.tf',
      }));

      // Still one abstract resource, but with two providers
      assert.strictEqual(map.resourceCount, 1);

      const providers = map.findConcrete('compute:service:user-api');
      assert.strictEqual(providers.length, 2);
    });

    it('should merge metadata from multiple registrations', () => {
      const map = createInfraResourceMap();

      map.register(makeMapping({
        metadata: { replicas: 3 },
      }));

      map.register(makeMapping({
        concreteId: 'infra:terraform:resource:user-api',
        concreteType: 'infra:terraform:aws_ecs_service',
        sourceTool: 'terraform',
        sourceFile: 'terraform/main.tf',
        metadata: { region: 'us-east-1' },
      }));

      const resource = map.findAbstract('user-api', 'compute:service');
      assert.ok(resource);
      assert.strictEqual(resource.metadata.replicas, 3);
      assert.strictEqual(resource.metadata.region, 'us-east-1');
    });

    it('should merge env from multiple registrations (string + string -> array)', () => {
      const map = createInfraResourceMap();

      map.register(makeMapping({
        env: 'prod',
      }));

      map.register(makeMapping({
        concreteId: 'infra:k8s:deployment:user-api-staging',
        concreteType: 'infra:k8s:deployment',
        sourceTool: 'kubernetes',
        sourceFile: 'k8s/staging/user-api.yaml',
        env: 'staging',
      }));

      const resource = map.findAbstract('user-api', 'compute:service');
      assert.ok(resource);

      // env should be combined into array (or contain both)
      const envs = Array.isArray(resource.env) ? resource.env : [resource.env];
      assert.ok(envs.includes('prod'), 'Should include prod');
      assert.ok(envs.includes('staging'), 'Should include staging');
    });
  });

  describe('findAbstract', () => {
    it('should find resource by name and type', () => {
      const map = createInfraResourceMap();
      map.register(makeMapping());

      const resource = map.findAbstract('user-api', 'compute:service');
      assert.ok(resource);
      assert.strictEqual(resource.id, 'compute:service:user-api');
      assert.strictEqual(resource.type, 'compute:service');
      assert.strictEqual(resource.name, 'user-api');
    });

    it('should return null for non-existent name', () => {
      const map = createInfraResourceMap();
      map.register(makeMapping());

      const resource = map.findAbstract('payment-api', 'compute:service');
      assert.strictEqual(resource, null);
    });

    it('should return null for non-existent type', () => {
      const map = createInfraResourceMap();
      map.register(makeMapping());

      const resource = map.findAbstract('user-api', 'storage:database:sql');
      assert.strictEqual(resource, null);
    });

    it('should return resource with all providers when multiple tools register same abstract', () => {
      const map = createInfraResourceMap();

      map.register(makeMapping({
        concreteId: 'infra:k8s:deployment:user-api',
        sourceTool: 'kubernetes',
      }));

      map.register(makeMapping({
        concreteId: 'infra:terraform:resource:user-api',
        concreteType: 'infra:terraform:aws_ecs_service',
        sourceTool: 'terraform',
        sourceFile: 'terraform/main.tf',
      }));

      const resource = map.findAbstract('user-api', 'compute:service');
      assert.ok(resource);
      assert.strictEqual(resource.providers.length, 2);

      const tools = resource.providers.map(p => p.tool).sort();
      assert.deepStrictEqual(tools, ['kubernetes', 'terraform']);
    });
  });

  describe('findConcrete', () => {
    it('should return providers for given abstractId', () => {
      const map = createInfraResourceMap();
      map.register(makeMapping());

      const providers = map.findConcrete('compute:service:user-api');
      assert.strictEqual(providers.length, 1);
      assert.strictEqual(providers[0].id, 'infra:k8s:deployment:user-api');
      assert.strictEqual(providers[0].tool, 'kubernetes');
      assert.strictEqual(providers[0].file, 'k8s/prod/user-api.yaml');
    });

    it('should return empty array for non-existent abstractId', () => {
      const map = createInfraResourceMap();
      map.register(makeMapping());

      const providers = map.findConcrete('compute:service:nonexistent');
      assert.deepStrictEqual(providers, []);
    });

    it('should return copy (not reference)', () => {
      const map = createInfraResourceMap();
      map.register(makeMapping());

      const providers1 = map.findConcrete('compute:service:user-api');
      const providers2 = map.findConcrete('compute:service:user-api');

      assert.notStrictEqual(providers1, providers2);
      assert.deepStrictEqual(providers1, providers2);

      // Mutating copy should not affect map
      providers1.push({ id: 'fake', type: 'fake', tool: 'fake', file: 'fake' });
      const providers3 = map.findConcrete('compute:service:user-api');
      assert.strictEqual(providers3.length, 1);
    });
  });

  describe('findByType', () => {
    it('should return all resources of a given type', () => {
      const map = createInfraResourceMap();

      map.register(makeMapping({
        abstractId: 'compute:service:user-api',
        name: 'user-api',
      }));

      map.register(makeMapping({
        concreteId: 'infra:k8s:deployment:payment-api',
        abstractId: 'compute:service:payment-api',
        name: 'payment-api',
        sourceFile: 'k8s/prod/payment-api.yaml',
      }));

      const services = map.findByType('compute:service');
      assert.strictEqual(services.length, 2);

      const names = services.map(s => s.name).sort();
      assert.deepStrictEqual(names, ['payment-api', 'user-api']);
    });

    it('should return empty array for type with no resources', () => {
      const map = createInfraResourceMap();
      map.register(makeMapping());

      const databases = map.findByType('storage:database:sql');
      assert.deepStrictEqual(databases, []);
    });

    it('should not include resources of different type', () => {
      const map = createInfraResourceMap();

      // Register compute:service
      map.register(makeMapping({
        abstractType: 'compute:service',
        abstractId: 'compute:service:user-api',
      }));

      // Register storage:database:sql
      map.register(makeMapping({
        concreteId: 'infra:k8s:pvc:user-db',
        concreteType: 'infra:k8s:pvc',
        abstractType: 'storage:database:sql',
        abstractId: 'storage:database:sql:user-db',
        name: 'user-db',
        sourceFile: 'k8s/prod/user-db.yaml',
      }));

      const services = map.findByType('compute:service');
      assert.strictEqual(services.length, 1);
      assert.strictEqual(services[0].name, 'user-api');

      const databases = map.findByType('storage:database:sql');
      assert.strictEqual(databases.length, 1);
      assert.strictEqual(databases[0].name, 'user-db');
    });
  });

  describe('findByEnv', () => {
    it('should match exact env string', () => {
      const map = createInfraResourceMap();

      map.register(makeMapping({
        abstractId: 'compute:service:user-api',
        name: 'user-api',
        env: 'prod',
      }));

      map.register(makeMapping({
        concreteId: 'infra:k8s:deployment:staging-api',
        abstractId: 'compute:service:staging-api',
        name: 'staging-api',
        env: 'staging',
        sourceFile: 'k8s/staging/api.yaml',
      }));

      const prodResources = map.findByEnv('prod');
      assert.strictEqual(prodResources.length, 1);
      assert.strictEqual(prodResources[0].name, 'user-api');
    });

    it('should match env in array', () => {
      const map = createInfraResourceMap();

      map.register(makeMapping({
        env: ['prod', 'staging'],
      }));

      const prodResources = map.findByEnv('prod');
      assert.strictEqual(prodResources.length, 1);

      const stagingResources = map.findByEnv('staging');
      assert.strictEqual(stagingResources.length, 1);
    });

    it('should include resources with undefined env (all environments)', () => {
      const map = createInfraResourceMap();

      // Resource without env means "all environments"
      map.register(makeMapping({
        env: undefined,
      }));

      const prodResources = map.findByEnv('prod');
      assert.strictEqual(prodResources.length, 1);
    });

    it('should not include resources with different env', () => {
      const map = createInfraResourceMap();

      map.register(makeMapping({
        env: 'staging',
      }));

      const prodResources = map.findByEnv('prod');
      assert.strictEqual(prodResources.length, 0);
    });
  });

  describe('getAll', () => {
    it('should return all registered abstract resources', () => {
      const map = createInfraResourceMap();

      map.register(makeMapping({
        abstractId: 'compute:service:user-api',
        name: 'user-api',
      }));

      map.register(makeMapping({
        concreteId: 'infra:k8s:pvc:user-db',
        concreteType: 'infra:k8s:pvc',
        abstractType: 'storage:database:sql',
        abstractId: 'storage:database:sql:user-db',
        name: 'user-db',
        sourceFile: 'k8s/prod/user-db.yaml',
      }));

      const all = map.getAll();
      assert.strictEqual(all.length, 2);

      const names = all.map(r => r.name).sort();
      assert.deepStrictEqual(names, ['user-api', 'user-db']);
    });

    it('should return empty array when nothing registered', () => {
      const map = createInfraResourceMap();
      const all = map.getAll();
      assert.deepStrictEqual(all, []);
    });
  });

  describe('createInfraResourceMap factory', () => {
    it('should create map with correct id (\'infra:resource:map\')', () => {
      const map = createInfraResourceMap();
      assert.strictEqual(map.id, 'infra:resource:map');
    });
  });
});
