/**
 * Plugin resolver tests — REG-380
 *
 * Verifies that custom plugins can import from @grafema/* packages
 * even when those packages aren't in the target project's node_modules/.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { register } from 'node:module';

// Resolve @grafema/* URLs from the CLI's perspective (workspace packages)
const coreUrl = import.meta.resolve('@grafema/core');
const typesUrl = import.meta.resolve('@grafema/types');

describe('pluginResolver', () => {
  describe('resolve function (unit)', () => {
    let resolver: { initialize: (data: unknown) => void; resolve: (specifier: string, context: unknown, next: (specifier: string, context: unknown) => unknown) => unknown };

    before(async () => {
      resolver = await import('../src/plugins/pluginResolver.js');
      resolver.initialize({
        grafemaPackages: {
          '@grafema/core': coreUrl,
          '@grafema/types': typesUrl,
        },
      });
    });

    it('resolves @grafema/core to the provided URL', () => {
      const next = () => { throw new Error('should not call next'); };
      const result = resolver.resolve('@grafema/core', {}, next);
      assert.deepStrictEqual(result, { url: coreUrl, shortCircuit: true });
    });

    it('resolves @grafema/types to the provided URL', () => {
      const next = () => { throw new Error('should not call next'); };
      const result = resolver.resolve('@grafema/types', {}, next);
      assert.deepStrictEqual(result, { url: typesUrl, shortCircuit: true });
    });

    it('passes through non-grafema specifiers', () => {
      const nextResult = { url: 'file:///something.js', shortCircuit: true };
      let nextCalled = false;
      const next = () => { nextCalled = true; return nextResult; };

      const result = resolver.resolve('lodash', {}, next);
      assert.ok(nextCalled, 'should call next for non-grafema specifiers');
      assert.strictEqual(result, nextResult);
    });

    it('passes through relative specifiers', () => {
      const nextResult = { url: 'file:///a/b.js', shortCircuit: true };
      const next = () => nextResult;
      const result = resolver.resolve('./utils.js', {}, next);
      assert.strictEqual(result, nextResult);
    });
  });

  describe('integration: custom plugin import (e2e)', () => {
    let tmpDir: string;

    before(() => {
      // Register the resolver hook for this process.
      // In production, this is called by registerPluginResolver() in analyze.ts.
      register(
        new URL('../src/plugins/pluginResolver.js', import.meta.url),
        {
          data: {
            grafemaPackages: {
              '@grafema/core': coreUrl,
              '@grafema/types': typesUrl,
            },
          },
        },
      );

      // Create a temp directory OUTSIDE the monorepo
      // so @grafema/core is NOT in any parent node_modules/
      tmpDir = join(tmpdir(), `grafema-plugin-test-${Date.now()}`);
      const pluginsDir = join(tmpDir, '.grafema', 'plugins');
      mkdirSync(pluginsDir, { recursive: true });

      // Write a plugin that imports from @grafema/core
      writeFileSync(
        join(pluginsDir, 'TestPlugin.mjs'),
        `
import { Plugin, createSuccessResult } from '@grafema/core';

export default class TestPlugin extends Plugin {
  get metadata() {
    return {
      name: 'TestPlugin',
      phase: 'VALIDATION',
      dependencies: [],
    };
  }

  async execute(context) {
    return createSuccessResult({ nodes: 0, edges: 0 });
  }
}
`,
      );
    });

    after(() => {
      if (tmpDir) {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('can dynamically import a plugin that uses @grafema/core', async () => {
      const pluginPath = join(tmpDir, '.grafema', 'plugins', 'TestPlugin.mjs');
      const pluginUrl = pathToFileURL(pluginPath).href;

      const mod = await import(pluginUrl);
      assert.ok(mod.default, 'should have a default export');
      assert.strictEqual(typeof mod.default, 'function', 'default export should be a class');
      assert.strictEqual(mod.default.name, 'TestPlugin');
    });

    it('plugin instance has correct Plugin prototype chain', async () => {
      const pluginPath = join(tmpDir, '.grafema', 'plugins', 'TestPlugin.mjs');
      const pluginUrl = pathToFileURL(pluginPath).href;

      const mod = await import(pluginUrl);
      const { Plugin } = await import('@grafema/core');

      const instance = new mod.default();
      assert.ok(instance instanceof Plugin, 'instance should be instanceof Plugin');
      assert.strictEqual(instance.metadata.name, 'TestPlugin');
      assert.strictEqual(instance.metadata.phase, 'VALIDATION');
    });

    it('plugin execute returns valid PluginResult', async () => {
      const pluginPath = join(tmpDir, '.grafema', 'plugins', 'TestPlugin.mjs');
      const pluginUrl = pathToFileURL(pluginPath).href;

      const mod = await import(pluginUrl);
      const instance = new mod.default();
      const result = await instance.execute({});

      assert.strictEqual(result.success, true);
      assert.deepStrictEqual(result.created, { nodes: 0, edges: 0 });
    });
  });
});
