/**
 * Registry unit tests (REG-676)
 *
 * Tests for registry utilities: resolvePackageDir, detectSourceType,
 * resolveEntryPoint, RegistryIndex serialization, loadFromRegistry.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { writeFileSync, mkdirSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  resolvePackageDir,
  detectSourceType,
  resolveEntryPoint,
  ManifestResolver,
} from '@grafema/util';

// ── resolvePackageDir ─────────────────────────────────────

describe('resolvePackageDir', () => {
  it('resolves a real installed package (yaml)', () => {
    const dir = resolvePackageDir('yaml', process.cwd());
    assert.ok(dir, 'should resolve yaml package directory');
    assert.ok(dir.includes('yaml'), `path should contain "yaml": ${dir}`);
  });

  it('resolves scoped packages (@grafema/util is workspace, so try a real one)', () => {
    // commander is always installed as a dep of the CLI
    const dir = resolvePackageDir('commander', process.cwd());
    assert.ok(dir, 'should resolve commander package directory');
  });

  it('returns null for non-existent package', () => {
    const dir = resolvePackageDir('this-package-definitely-does-not-exist-xyz', process.cwd());
    assert.strictEqual(dir, null);
  });
});

// ── detectSourceType ──────────────────────────────────────

describe('detectSourceType', () => {
  let tempDir;

  before(() => {
    tempDir = join(tmpdir(), `registry-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  after(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('detects @types/* as dts_only', () => {
    const pkgDir = join(tempDir, 'types-node');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
      name: '@types/node',
      version: '20.0.0',
      types: 'index.d.ts',
    }));
    assert.strictEqual(detectSourceType(pkgDir), 'dts_only');
  });

  it('detects types-only package (types but no main/exports)', () => {
    const pkgDir = join(tempDir, 'types-only');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
      name: 'my-types',
      version: '1.0.0',
      types: 'index.d.ts',
    }));
    assert.strictEqual(detectSourceType(pkgDir), 'dts_only');
  });

  it('detects source TypeScript package', () => {
    const pkgDir = join(tempDir, 'source-pkg');
    mkdirSync(join(pkgDir, 'src'), { recursive: true });
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
      name: 'source-pkg',
      version: '1.0.0',
      main: 'dist/index.js',
    }));
    writeFileSync(join(pkgDir, 'src', 'index.ts'), 'export const x = 1;');
    assert.strictEqual(detectSourceType(pkgDir), 'source');
  });

  it('defaults to compiled_js for standard npm packages', () => {
    const pkgDir = join(tempDir, 'compiled-pkg');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
      name: 'compiled-pkg',
      version: '1.0.0',
      main: 'index.js',
    }));
    assert.strictEqual(detectSourceType(pkgDir), 'compiled_js');
  });

  it('returns compiled_js for missing package.json', () => {
    const pkgDir = join(tempDir, 'no-pkg-json');
    mkdirSync(pkgDir, { recursive: true });
    assert.strictEqual(detectSourceType(pkgDir), 'compiled_js');
  });
});

// ── resolveEntryPoint ─────────────────────────────────────

describe('resolveEntryPoint', () => {
  it('resolves from exports["."] string', () => {
    const result = resolveEntryPoint({
      exports: { '.': './dist/index.js' },
    });
    assert.strictEqual(result, './dist/index.js');
  });

  it('resolves from exports["."].import', () => {
    const result = resolveEntryPoint({
      exports: { '.': { import: './dist/esm/index.js', require: './dist/cjs/index.js' } },
    });
    assert.strictEqual(result, './dist/esm/index.js');
  });

  it('resolves from exports["."].default when import is missing', () => {
    const result = resolveEntryPoint({
      exports: { '.': { default: './dist/index.js' } },
    });
    assert.strictEqual(result, './dist/index.js');
  });

  it('resolves nested conditions (import.default)', () => {
    const result = resolveEntryPoint({
      exports: {
        '.': {
          import: { types: './dist/index.d.ts', default: './dist/index.mjs' },
        },
      },
    });
    assert.strictEqual(result, './dist/index.mjs');
  });

  it('falls back to main field', () => {
    const result = resolveEntryPoint({ main: 'lib/index.js' });
    assert.strictEqual(result, 'lib/index.js');
  });

  it('falls back to module field', () => {
    const result = resolveEntryPoint({ module: 'esm/index.js' });
    assert.strictEqual(result, 'esm/index.js');
  });

  it('prefers exports over main', () => {
    const result = resolveEntryPoint({
      exports: { '.': './dist/index.js' },
      main: 'lib/index.js',
    });
    assert.strictEqual(result, './dist/index.js');
  });

  it('returns null when no entry found', () => {
    const result = resolveEntryPoint({ name: 'foo', version: '1.0.0' });
    assert.strictEqual(result, null);
  });
});

// ── loadFromRegistry ──────────────────────────────────────

describe('ManifestResolver.loadFromRegistry', () => {
  let registryDir;

  before(() => {
    registryDir = join(tmpdir(), `registry-resolver-test-${Date.now()}`);

    // Write manifests as raw YAML
    const manifest1Yaml = `schema_version: 1
analyzer_version: "0.3.16"
authored: false
confidence: 0.85
generated: "2026-03-17T00:00:00Z"
package:
  purl: "pkg:npm/commander@13.1.0"
  source_type: compiled_js
exports:
  - name: Command
    kind: CLASS
    semanticId: "lib/command.js->CLASS->Command"
    effects:
      - PURE
    params: []
  - name: Option
    kind: CLASS
    semanticId: "lib/option.js->CLASS->Option"
    effects:
      - PURE
    params: []
imports: []
capabilities:
  total_exports: 2
  total_internal_symbols: 50
  has_graph: true
`;

    const manifest2Yaml = `schema_version: 1
analyzer_version: "0.3.16"
authored: false
confidence: 0.92
generated: "2026-03-17T00:00:00Z"
package:
  purl: "pkg:npm/yaml@2.8.2"
  source_type: compiled_js
exports:
  - name: parse
    kind: FUNCTION
    semanticId: "dist/index.js->FUNCTION->parse"
    effects:
      - PURE
    params: []
  - name: stringify
    kind: FUNCTION
    semanticId: "dist/index.js->FUNCTION->stringify"
    effects:
      - PURE
    params: []
imports: []
capabilities:
  total_exports: 2
  total_internal_symbols: 30
  has_graph: true
`;

    const indexYaml = `schema_version: 1
generated: "2026-03-17T00:00:00Z"
analyzer_version: "0.3.16"
entries:
  - name: commander
    version: "13.1.0"
    purl: "pkg:npm/commander@13.1.0"
    source_type: compiled_js
    confidence: 0.85
    total_exports: 2
  - name: yaml
    version: "2.8.2"
    purl: "pkg:npm/yaml@2.8.2"
    source_type: compiled_js
    confidence: 0.92
    total_exports: 2
`;

    const cmd13Dir = join(registryDir, 'commander', '13.1.0');
    const yaml28Dir = join(registryDir, 'yaml', '2.8.2');
    mkdirSync(cmd13Dir, { recursive: true });
    mkdirSync(yaml28Dir, { recursive: true });
    writeFileSync(join(cmd13Dir, 'manifest.yaml'), manifest1Yaml);
    writeFileSync(join(yaml28Dir, 'manifest.yaml'), manifest2Yaml);
    writeFileSync(join(registryDir, 'index.yaml'), indexYaml);
  });

  after(() => {
    rmSync(registryDir, { recursive: true, force: true });
  });

  it('loads all manifests from registry', () => {
    const resolver = new ManifestResolver();
    const loaded = resolver.loadFromRegistry(registryDir);
    assert.strictEqual(loaded, 2);
    assert.ok(resolver.has('commander'));
    assert.ok(resolver.has('yaml'));
  });

  it('resolves symbols from registry-loaded manifests', () => {
    const resolver = new ManifestResolver();
    resolver.loadFromRegistry(registryDir);

    const result = resolver.resolve('commander', 'Command');
    assert.ok(result);
    assert.strictEqual(result.export.name, 'Command');
    assert.strictEqual(result.export.kind, 'CLASS');
    assert.strictEqual(result.packagePurl, 'pkg:npm/commander@13.1.0');
  });

  it('filters by package names', () => {
    const resolver = new ManifestResolver();
    const loaded = resolver.loadFromRegistry(registryDir, ['yaml']);
    assert.strictEqual(loaded, 1);
    assert.ok(resolver.has('yaml'));
    assert.ok(!resolver.has('commander'));
  });

  it('returns 0 for non-existent registry', () => {
    const resolver = new ManifestResolver();
    const loaded = resolver.loadFromRegistry('/tmp/nonexistent-registry-xyz');
    assert.strictEqual(loaded, 0);
  });
});
