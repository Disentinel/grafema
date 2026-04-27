/**
 * Tests for commanderExtractor (REG-1112).
 *
 * The commanderExtractor implements SpecedContractExtractor for `cli:command`
 * FEATURE nodes produced by libraryCallbackEnricher. Each test seeds a small
 * synthetic graph that mirrors what the JS analyzer + libraryCallbackEnricher
 * would produce for one of:
 *
 *   const cmd = new Command('build <input>')
 *     .description('Build the project')
 *     .argument('[output]', 'output directory', 'dist')
 *     .option('-w, --watch', 'enable watch mode')
 *     .option('--depth <n>', 'depth', '5')
 *     .action(handler);
 *
 * We run libraryCallbackEnricher first to produce the cli:command FEATURE,
 * then invoke the extractor directly (bypassing the framework) and verify
 * the returned SpecedContractData. Going through the framework as well would
 * be redundant — the framework's own tests already cover dispatch.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { EffectsLookup } from '@grafema/util';
import { enrichLibraryCallbacks } from '@grafema/util/enrichers/libraryCallbackEnricher';
import { commanderExtractor } from '@grafema/util/enrichers/extractors/commanderExtractor';
import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';

// ---------------------------------------------------------------------------
// One effects-db with the commander entries the enricher uses.
// ---------------------------------------------------------------------------

let effectsDbDir;
let effectsLookup;

before(() => {
  effectsDbDir = mkdtempSync(join(tmpdir(), 'effectsdb-cmd-extr-'));
  mkdirSync(join(effectsDbDir, 'packages'), { recursive: true });
  mkdirSync(join(effectsDbDir, 'runtimes'), { recursive: true });
  writeFileSync(
    join(effectsDbDir, 'packages', 'commander.yaml'),
    [
      'commander:',
      '  Command.command:',
      '    effects: [MUTATION]',
      '    args:',
      '      - index: 0',
      '        role: COMMAND_NAME',
      '    returns: { type: Command }',
      '  Command.action:',
      '    effects: [MUTATION]',
      '    args:',
      '      - index: 0',
      '        role: ENTRY_POINT_CALLBACK',
      '    returns: { type: Command }',
      '  Command.description: { effects: [MUTATION], returns: { type: Command } }',
      '  Command.argument:    { effects: [MUTATION], returns: { type: Command } }',
      '  Command.option:      { effects: [MUTATION], returns: { type: Command } }',
      '  Command.requiredOption: { effects: [MUTATION], returns: { type: Command } }',
      '',
    ].join('\n'),
  );
  effectsLookup = EffectsLookup.load(effectsDbDir);
});

after(async () => {
  if (effectsDbDir) rmSync(effectsDbDir, { recursive: true, force: true });
  await cleanupAllTestDatabases();
});

// ---------------------------------------------------------------------------
// Fixture builder. Each test calls `seed()` with a list of step descriptors
// that describe one chained method call each. The first step is the chain
// origin; subsequent steps are RECEIVER_CALL → previous step.
//
// Step shape:
//   { method: 'command' | 'argument' | 'option' | 'description' | 'action',
//     args: [ { kind: 'literal' | 'function', value?: string, name?: string } ] }
//
// `kind: 'function'` is used for the action handler — the rest are literals.
// `method: 'command'` produces the chain-origin call.
// ---------------------------------------------------------------------------

let nodeCounter = 0;
function nextId(prefix) {
  return `t${++nodeCounter}::${prefix}`;
}

async function seed(backend, file, steps) {
  // Module + scope + import binding for `Command`.
  const moduleId = nextId('module');
  const scopeId = nextId('scope');
  const ibId = nextId('ib');
  await backend.addNodes([
    { id: moduleId, type: 'MODULE', name: file, file, relativePath: file, contentHash: 'h1' },
    { id: scopeId, type: 'SCOPE', name: 'global', file, scopeType: 'module' },
    {
      id: ibId,
      type: 'IMPORT_BINDING',
      name: 'Command',
      file,
      importedName: 'Command',
      source: 'commander',
    },
  ]);
  await backend.addEdges([
    { src: moduleId, dst: scopeId, type: 'HAS_SCOPE' },
    { src: scopeId, dst: ibId, type: 'DECLARES' },
  ]);

  let prevCallId = null;
  let actionCallId = null;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const callId = nextId(`call-${step.method}`);
    const isOrigin = i === 0;
    const isAction = step.method === 'action';

    // Chain origin is `new Command(...)`: name=Command, kind=new.
    // Other calls are receiver chains: name=`<obj>.<method>`.
    const callNode = isOrigin
      ? {
          id: callId,
          type: 'CALL',
          name: 'Command',
          file,
          kind: 'new',
          argCount: step.args.length,
        }
      : {
          id: callId,
          type: 'CALL',
          name: `<obj>.${step.method}`,
          file,
          argCount: step.args.length,
        };
    await backend.addNode(callNode);

    if (prevCallId) {
      // outer-call.RECEIVER_CALL → inner-call (RECEIVER chain points
      // anchor → ... → origin, so each new call is the OUTER and prev is INNER).
      await backend.addEdge({ src: callId, dst: prevCallId, type: 'RECEIVER_CALL' });
    }

    for (let argIdx = 0; argIdx < step.args.length; argIdx++) {
      const arg = step.args[argIdx];
      const argId = nextId(`arg-${argIdx}`);
      if (arg.kind === 'literal') {
        await backend.addNode({
          id: argId,
          type: 'LITERAL',
          name: arg.value ?? '',
          file,
          value: arg.value ?? '',
        });
      } else {
        await backend.addNode({
          id: argId,
          type: 'FUNCTION',
          name: arg.name ?? 'handler',
          file,
          async: false,
          generator: false,
          exported: false,
          arrowFunction: true,
        });
      }
      await backend.addEdge({
        src: callId,
        dst: argId,
        type: 'PASSES_ARGUMENT',
        index: argIdx,
      });
    }

    if (isAction) actionCallId = callId;
    prevCallId = callId;
  }

  return { actionCallId };
}

/** Look up the cli:command FEATURE node (after enricher run). */
async function getCliCommandFeature(client) {
  for await (const wn of client.queryNodes({ type: 'cli:command' })) return wn;
  return null;
}

/**
 * Run libraryCallbackEnricher to materialise the cli:command FEATURE, then
 * invoke commanderExtractor on it. Returns the extractor's result.
 */
async function runEnricherThenExtract(client) {
  const r = await enrichLibraryCallbacks(client, effectsLookup);
  assert.ok(r.domainNodesCreated >= 1, 'libraryCallbackEnricher should have created cli:command');
  const feature = await getCliCommandFeature(client);
  assert.ok(feature, 'cli:command FEATURE should exist');
  return commanderExtractor.extract(client, feature);
}

// ---------------------------------------------------------------------------

describe('commanderExtractor', () => {
  /** @type {Awaited<ReturnType<typeof createTestDatabase>>} */
  let db;
  /** @type {any} */
  let backend;
  /** @type {any} */
  let client;

  beforeEach(async () => {
    if (db) await db.cleanup();
    db = await createTestDatabase();
    backend = db.backend;
    client = backend.client;
  });

  it('command with no args produces empty inputs', async () => {
    await seed(backend, 'cli.ts', [
      { method: 'command', args: [{ kind: 'literal', value: 'analyze' }] },
      { method: 'action', args: [{ kind: 'function', name: 'analyzeAction' }] },
    ]);

    const data = await runEnricherThenExtract(client);
    assert.ok(data, 'extractor should not return null');
    assert.equal(data.source, 'commander');
    assert.equal(data.inputs.length, 0);
    assert.equal(data.errors.length, 0);
  });

  it('required positional <input> produces one input with optional=false', async () => {
    await seed(backend, 'cli.ts', [
      { method: 'command', args: [{ kind: 'literal', value: 'build <input>' }] },
      { method: 'action', args: [{ kind: 'function', name: 'buildAction' }] },
    ]);

    const data = await runEnricherThenExtract(client);
    assert.ok(data);
    assert.equal(data.inputs.length, 1);
    assert.equal(data.inputs[0].name, 'input');
    assert.equal(data.inputs[0].optional, false);
    assert.equal(data.inputs[0].type, 'string');
  });

  it('optional positional [output] produces one input with optional=true', async () => {
    await seed(backend, 'cli.ts', [
      { method: 'command', args: [{ kind: 'literal', value: 'build [output]' }] },
      { method: 'action', args: [{ kind: 'function' }] },
    ]);

    const data = await runEnricherThenExtract(client);
    assert.ok(data);
    assert.equal(data.inputs.length, 1);
    assert.equal(data.inputs[0].name, 'output');
    assert.equal(data.inputs[0].optional, true);
  });

  it('variadic <files...> produces array-typed input flagged as variadic', async () => {
    await seed(backend, 'cli.ts', [
      { method: 'command', args: [{ kind: 'literal', value: 'lint <files...>' }] },
      { method: 'action', args: [{ kind: 'function' }] },
    ]);

    const data = await runEnricherThenExtract(client);
    assert.ok(data);
    assert.equal(data.inputs.length, 1);
    assert.equal(data.inputs[0].name, 'files');
    assert.equal(data.inputs[0].type, 'string[]');
    assert.equal(data.inputs[0].optional, false);
    // v2: variadic is a structured field, not a description workaround.
    assert.equal(data.inputs[0].variadic, true);
    assert.equal(data.inputs[0].description, undefined);
  });

  it('boolean flag -w, --watch produces option input named --watch with boolean type', async () => {
    await seed(backend, 'cli.ts', [
      { method: 'command', args: [{ kind: 'literal', value: 'analyze' }] },
      {
        method: 'option',
        args: [
          { kind: 'literal', value: '-w, --watch' },
          { kind: 'literal', value: 'enable watch mode' },
        ],
      },
      { method: 'action', args: [{ kind: 'function' }] },
    ]);

    const data = await runEnricherThenExtract(client);
    assert.ok(data);
    assert.equal(data.inputs.length, 1);
    const opt = data.inputs[0];
    assert.equal(opt.name, '--watch');
    assert.equal(opt.type, 'boolean');
    assert.equal(opt.optional, true);
    assert.equal(opt.description, 'enable watch mode');
  });

  it('valued option --depth <n> with default "5" carries default field', async () => {
    await seed(backend, 'cli.ts', [
      { method: 'command', args: [{ kind: 'literal', value: 'analyze' }] },
      {
        method: 'option',
        args: [
          { kind: 'literal', value: '--depth <n>' },
          { kind: 'literal', value: 'descend N levels' },
          { kind: 'literal', value: '5' },
        ],
      },
      { method: 'action', args: [{ kind: 'function' }] },
    ]);

    const data = await runEnricherThenExtract(client);
    assert.ok(data);
    assert.equal(data.inputs.length, 1);
    const opt = data.inputs[0];
    assert.equal(opt.name, '--depth');
    assert.equal(opt.type, 'string');
    assert.equal(opt.optional, true);
    assert.equal(opt.default, '5');
    assert.equal(opt.description, 'descend N levels');
  });

  it('returns null when the FEATURE has no recoverable spec backing', async () => {
    // Build a synthetic cli:command FEATURE with no anchorCall metadata —
    // simulating a future code path that produces FEATUREs without the
    // libraryCallbackEnricher chain (e.g. user-authored fixture). The
    // extractor must return null.
    const file = 'orphan.ts';
    await backend.addNodes([
      { id: 'orphan::module', type: 'MODULE', name: file, file, relativePath: file, contentHash: 'h1' },
      {
        id: 'orphan::feature',
        type: 'cli:command',
        name: 'orphan',
        file,
        // Note: no `anchorCall` in the fields → metadata won't have it either.
      },
    ]);

    const feature = await getCliCommandFeature(client);
    assert.ok(feature, 'cli:command FEATURE should exist');
    const data = await commanderExtractor.extract(client, feature);
    assert.equal(data, null);
  });

  it('v2: top-level name + description populated from .command(spec, desc)', async () => {
    await seed(backend, 'cli.ts', [
      {
        method: 'command',
        args: [
          { kind: 'literal', value: 'build <input>' },
          { kind: 'literal', value: 'Build the project' },
        ],
      },
      { method: 'action', args: [{ kind: 'function' }] },
    ]);

    const data = await runEnricherThenExtract(client);
    assert.ok(data);
    assert.equal(data.name, 'build');
    assert.equal(data.description, 'Build the project');
    // v2: description is no longer encoded into outputs[0].
    assert.equal(data.outputs.length, 0);
  });

  it('v2: top-level description populated from chained .description("…") call', async () => {
    await seed(backend, 'cli.ts', [
      { method: 'command', args: [{ kind: 'literal', value: 'analyze' }] },
      { method: 'description', args: [{ kind: 'literal', value: 'Run analysis' }] },
      { method: 'action', args: [{ kind: 'function' }] },
    ]);

    const data = await runEnricherThenExtract(client);
    assert.ok(data);
    assert.equal(data.description, 'Run analysis');
    assert.equal(data.outputs.length, 0);
  });

  it('multi-command: two independent FEATUREs each yield their own spec', async () => {
    // Two separate command chains in the same file. libraryCallbackEnricher
    // creates two cli:command FEATUREs; commanderExtractor must extract each
    // independently from its own anchor call.
    await seed(backend, 'multi.ts', [
      { method: 'command', args: [{ kind: 'literal', value: 'build <input>' }] },
      { method: 'action', args: [{ kind: 'function', name: 'buildAction' }] },
    ]);
    await seed(backend, 'multi.ts', [
      { method: 'command', args: [{ kind: 'literal', value: 'serve' }] },
      {
        method: 'option',
        args: [
          { kind: 'literal', value: '-p, --port <n>' },
          { kind: 'literal', value: 'port' },
          { kind: 'literal', value: '3000' },
        ],
      },
      { method: 'action', args: [{ kind: 'function', name: 'serveAction' }] },
    ]);

    // Run libraryCallbackEnricher once for both; gather all features.
    const r = await enrichLibraryCallbacks(client, effectsLookup);
    assert.equal(r.domainNodesCreated, 2);

    const features = [];
    for await (const wn of client.queryNodes({ type: 'cli:command' })) features.push(wn);
    assert.equal(features.length, 2);

    const results = [];
    for (const feat of features) {
      const data = await commanderExtractor.extract(client, feat);
      assert.ok(data, `extractor should not return null for ${feat.name}`);
      results.push({ name: feat.name, data });
    }

    // libraryCallbackEnricher uses the full spec string as the FEATURE name
    // (it doesn't split on whitespace). Match by `startsWith` to identify
    // each command.
    const build = results.find(r => r.name.startsWith('build'));
    const serve = results.find(r => r.name === 'serve');
    assert.ok(build, 'build feature found');
    assert.ok(serve, 'serve feature found');

    // build: one positional <input>, no options
    assert.equal(build.data.inputs.length, 1);
    assert.equal(build.data.inputs[0].name, 'input');
    assert.equal(build.data.inputs[0].optional, false);

    // serve: no positionals, one --port option with default
    assert.equal(serve.data.inputs.length, 1);
    assert.equal(serve.data.inputs[0].name, '--port');
    assert.equal(serve.data.inputs[0].default, '3000');
  });
});
