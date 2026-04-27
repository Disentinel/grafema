/**
 * Tests for vscodeContributesExtractor (REG-1114).
 *
 * The extractor reads a `vscode:command` FEATURE node's `name` (the command
 * id), walks upward from `feature.file` to the nearest package.json with a
 * matching `contributes.commands[]` entry, and produces SpecedContractData
 * with `source: 'vscode-contributes'`. The actual RFDB client is unused —
 * everything is done off the filesystem — so these tests don't seed a graph.
 *
 * Each test creates a temp directory tree with a synthetic package.json and
 * a fake source file. The feature node is built in-memory; we pass null for
 * the client (extractor signature accepts it but doesn't call it).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { vscodeContributesExtractor } from '@grafema/util/enrichers/extractors/vscodeContributesExtractor';

let tmpRoot;

before(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'vscode-contrib-extr-'));
});

after(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

let dirCounter = 0;
function freshDir(label) {
  const dir = join(tmpRoot, `${label}-${++dirCounter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Build a minimal feature WireNode shape. */
function makeFeature({ name, file }) {
  return {
    id: `feat::${name}`,
    nodeType: 'vscode:command',
    name,
    file,
    exported: false,
    metadata: JSON.stringify({}),
  };
}

describe('vscodeContributesExtractor', () => {
  it('command found in contributes.commands[] with title and category', async () => {
    const extDir = freshDir('ext');
    const srcDir = join(extDir, 'src');
    mkdirSync(srcDir);
    writeFileSync(
      join(extDir, 'package.json'),
      JSON.stringify({
        name: 'fixture-ext',
        contributes: {
          commands: [
            { command: 'graf.refresh', title: 'Refresh Graph', category: 'Grafema' },
          ],
        },
      }),
    );
    const featureFile = join(srcDir, 'extension.ts');
    writeFileSync(featureFile, '// fake');

    const data = await vscodeContributesExtractor.extract(
      /** @type {any} */ (null),
      makeFeature({ name: 'graf.refresh', file: featureFile }),
    );
    assert.ok(data, 'extractor should not return null');
    assert.equal(data.source, 'vscode-contributes');
    assert.equal(data.inputs.length, 0);
    assert.equal(data.errors.length, 0);
    // v2: top-level fields carry the command id and human label.
    assert.equal(data.name, 'graf.refresh');
    // Title qualified with category — matches how VS Code renders it.
    assert.equal(data.description, 'Grafema: Refresh Graph');
  });

  it('feature.name with surrounding quotes is normalised before matching', async () => {
    const extDir = freshDir('ext');
    const srcDir = join(extDir, 'src');
    mkdirSync(srcDir);
    writeFileSync(
      join(extDir, 'package.json'),
      JSON.stringify({
        contributes: {
          commands: [{ command: 'graf.refresh', title: 'Refresh' }],
        },
      }),
    );
    const featureFile = join(srcDir, 'extension.ts');
    writeFileSync(featureFile, '// fake');

    // Defensive: name carries the literal quotes from source.
    const data = await vscodeContributesExtractor.extract(
      /** @type {any} */ (null),
      makeFeature({ name: "'graf.refresh'", file: featureFile }),
    );
    assert.ok(data, 'extractor should match after stripping quotes');
    assert.equal(data.description, 'Refresh');
  });

  it('command not in package.json returns null', async () => {
    const extDir = freshDir('ext');
    const srcDir = join(extDir, 'src');
    mkdirSync(srcDir);
    writeFileSync(
      join(extDir, 'package.json'),
      JSON.stringify({
        contributes: {
          commands: [{ command: 'graf.foo', title: 'Foo' }],
        },
      }),
    );
    const featureFile = join(srcDir, 'extension.ts');
    writeFileSync(featureFile, '// fake');

    const data = await vscodeContributesExtractor.extract(
      /** @type {any} */ (null),
      makeFeature({ name: 'graf.bar', file: featureFile }),
    );
    assert.equal(data, null);
  });

  it('command with menu placements emits one outputs row per menu entry', async () => {
    const extDir = freshDir('ext');
    const srcDir = join(extDir, 'src');
    mkdirSync(srcDir);
    writeFileSync(
      join(extDir, 'package.json'),
      JSON.stringify({
        contributes: {
          commands: [{ command: 'graf.refresh', title: 'Refresh' }],
          menus: {
            'view/title': [
              { command: 'graf.refresh', when: 'view == grafemaExplore', group: 'navigation@0' },
              { command: 'graf.other', when: 'view == grafemaStatus' },
            ],
            'view/item/context': [
              { command: 'graf.refresh', when: 'viewItem == node', group: 'inline' },
            ],
          },
        },
      }),
    );
    const featureFile = join(srcDir, 'extension.ts');
    writeFileSync(featureFile, '// fake');

    const data = await vscodeContributesExtractor.extract(
      /** @type {any} */ (null),
      makeFeature({ name: 'graf.refresh', file: featureFile }),
    );
    assert.ok(data);
    // v2: outputs are pure menu/keybinding rows — no title row anymore.
    const menuRows = data.outputs.filter(o => o.kind === 'menu');
    assert.equal(menuRows.length, 2, 'exactly two menu placements target graf.refresh');
    assert.ok(menuRows.some(r => r.description.includes('view/title')));
    assert.ok(menuRows.some(r => r.description.includes('view/item/context')));
    // The when-clause and group are preserved in the description.
    assert.ok(menuRows.some(r => r.description.includes('when: view == grafemaExplore')));
    assert.ok(menuRows.some(r => r.description.includes('group: inline')));
  });

  it('command with keybindings emits one outputs row per binding', async () => {
    const extDir = freshDir('ext');
    const srcDir = join(extDir, 'src');
    mkdirSync(srcDir);
    writeFileSync(
      join(extDir, 'package.json'),
      JSON.stringify({
        contributes: {
          commands: [{ command: 'graf.toggle', title: 'Toggle' }],
          keybindings: [
            {
              command: 'graf.toggle',
              key: 'ctrl+shift+g',
              mac: 'cmd+shift+g',
              when: 'editorTextFocus',
            },
            { command: 'graf.unrelated', key: 'ctrl+1' },
          ],
        },
      }),
    );
    const featureFile = join(srcDir, 'extension.ts');
    writeFileSync(featureFile, '// fake');

    const data = await vscodeContributesExtractor.extract(
      /** @type {any} */ (null),
      makeFeature({ name: 'graf.toggle', file: featureFile }),
    );
    assert.ok(data);
    const kbRows = data.outputs.filter(o => o.kind === 'keybinding');
    assert.equal(kbRows.length, 1, 'exactly one keybinding targets graf.toggle');
    const desc = kbRows[0].description;
    assert.ok(desc.includes('key: ctrl+shift+g'));
    assert.ok(desc.includes('mac: cmd+shift+g'));
    assert.ok(desc.includes('when: editorTextFocus'));
  });

  it('no package.json walking up the tree returns null without crashing', async () => {
    // tmp/ext-N/src/extension.ts but NO package.json anywhere ABOVE this — we
    // place the file under our isolated tmpRoot and the walker should bail at
    // the filesystem root without throwing. (The user's home / root filesystem
    // may legitimately contain a package.json; we accept that the test is a
    // smoke test for "no crash" rather than a strict "returns null".)
    const extDir = freshDir('orphan');
    const srcDir = join(extDir, 'deeply', 'nested');
    mkdirSync(srcDir, { recursive: true });
    const featureFile = join(srcDir, 'extension.ts');
    writeFileSync(featureFile, '// fake');

    const data = await vscodeContributesExtractor.extract(
      /** @type {any} */ (null),
      makeFeature({ name: 'graf.nonexistent.command.id.xyz', file: featureFile }),
    );
    // The command id is randomly distinct enough that no real package.json on
    // the path would declare it. Result must be null, not a thrown exception.
    assert.equal(data, null);
  });

  it('walks past workspace-root package.json without contributes to find sub-package', async () => {
    // Layout:
    //   workspace/
    //     package.json   (no contributes)
    //     packages/ext/
    //       package.json (contributes.commands has graf.refresh)
    //       src/extension.ts  ← feature.file
    const ws = freshDir('ws');
    writeFileSync(
      join(ws, 'package.json'),
      JSON.stringify({ name: 'monorepo-root', private: true, workspaces: ['packages/*'] }),
    );
    const extDir = join(ws, 'packages', 'ext');
    const srcDir = join(extDir, 'src');
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(
      join(extDir, 'package.json'),
      JSON.stringify({
        name: 'sub-extension',
        contributes: {
          commands: [{ command: 'graf.refresh', title: 'Refresh from Sub-package' }],
        },
      }),
    );
    const featureFile = join(srcDir, 'extension.ts');
    writeFileSync(featureFile, '// fake');

    const data = await vscodeContributesExtractor.extract(
      /** @type {any} */ (null),
      makeFeature({ name: 'graf.refresh', file: featureFile }),
    );
    assert.ok(data, 'extractor must reach the sub-package despite root pkg.json having no contributes');
    assert.equal(data.description, 'Refresh from Sub-package');
  });

  it('v2: top-level name = command id (no quotes), outputs carry kind tags', async () => {
    const extDir = freshDir('ext');
    const srcDir = join(extDir, 'src');
    mkdirSync(srcDir);
    writeFileSync(
      join(extDir, 'package.json'),
      JSON.stringify({
        contributes: {
          commands: [{ command: 'graf.ping', title: 'Ping' }],
          menus: {
            'view/title': [{ command: 'graf.ping', when: 'view == grafema' }],
          },
          keybindings: [{ command: 'graf.ping', key: 'ctrl+p' }],
        },
      }),
    );
    const featureFile = join(srcDir, 'extension.ts');
    writeFileSync(featureFile, '// fake');

    const data = await vscodeContributesExtractor.extract(
      /** @type {any} */ (null),
      makeFeature({ name: "'graf.ping'", file: featureFile }),
    );
    assert.ok(data);
    assert.equal(data.name, 'graf.ping');
    assert.equal(data.description, 'Ping');
    const kinds = data.outputs.map((o) => o.kind);
    assert.ok(kinds.includes('menu'));
    assert.ok(kinds.includes('keybinding'));
  });

  it('closest package.json with matching command wins (sub-package over root)', async () => {
    // Layout where BOTH roots declare a command with the same id, but the
    // closest ancestor's title should win.
    const ws = freshDir('ws');
    writeFileSync(
      join(ws, 'package.json'),
      JSON.stringify({
        contributes: {
          commands: [{ command: 'graf.refresh', title: 'Root Title' }],
        },
      }),
    );
    const extDir = join(ws, 'packages', 'ext');
    const srcDir = join(extDir, 'src');
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(
      join(extDir, 'package.json'),
      JSON.stringify({
        contributes: {
          commands: [{ command: 'graf.refresh', title: 'Sub Title' }],
        },
      }),
    );
    const featureFile = join(srcDir, 'extension.ts');
    writeFileSync(featureFile, '// fake');

    const data = await vscodeContributesExtractor.extract(
      /** @type {any} */ (null),
      makeFeature({ name: 'graf.refresh', file: featureFile }),
    );
    assert.ok(data);
    assert.equal(data.description, 'Sub Title');
  });
});
