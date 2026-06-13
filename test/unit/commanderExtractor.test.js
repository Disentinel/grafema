/**
 * Tests for commanderExtractor (REG-1112).
 *
 * The commanderExtractor implements SpecedContractExtractor for `cli:command`
 * FEATURE nodes. Each test seeds a small synthetic graph that mirrors what the
 * JS analyzer + the `js_entrypoint_features_nodes` / `_edges` DERIVE PACKS now
 * produce for one of:
 *
 *   const cmd = new Command('build <input>')
 *     .description('Build the project')
 *     .argument('[output]', 'output directory', 'dist')
 *     .option('-w, --watch', 'enable watch mode')
 *     .option('--depth <n>', 'depth', '5')
 *     .action(handler);
 *
 * HISTORY: these tests used to materialise the `cli:command` FEATURE by running
 * `libraryCallbackEnricher`. As of Loop-2 (continuing the Wave-14 HTTP
 * precedent, PR #397) commander/`@modelcontextprotocol/sdk`/vscode were RETIRED
 * from that enricher's LIBRARY_NODE_TYPE map — the default-on
 * `js_entrypoint_features_nodes` / `_edges` derive packs are now the sole
 * producer of js `cli:command` / `mcp:tool` / `vscode:command` nodes. So the
 * enricher seeding no longer mints a FEATURE and the extractor tests had nothing
 * to consume.
 *
 * `commanderExtractor` itself is NOT retired — it still transforms any
 * `cli:command` node → SpecedContractData at runtime regardless of who minted
 * it. These tests now seed the `cli:command` node DIRECTLY in the exact shape
 * the derive pack emits (node `metadata.anchorCall` = the `.action`
 * registration call id, `metadata.method` = the BARE method name `action`,
 * `metadata.library` = `commander`), anchored on the seeded `.action` CALL of
 * the chain. This exercises the REAL runtime input contract of the extractor —
 * the same contract the pack's @materialize_node output satisfies in
 * production. Going through the framework as well would be redundant.
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { commanderExtractor } from '@grafema/util/enrichers/extractors/commanderExtractor';
import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';

// No effects-db / enricher needed any more: the cli:command FEATURE is minted
// by the js_entrypoint_features derive pack in production, so these tests seed
// the FEATURE node directly (the #403 httpRouteExtractor reseed precedent).

after(async () => {
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

/** Look up the cli:command FEATURE node. */
async function getCliCommandFeature(client) {
  for await (const wn of client.queryNodes({ type: 'cli:command' })) return wn;
  return null;
}

/** Find the wire node for the `<obj>.action` CALL in the seeded chain. */
async function findActionCallWire(client) {
  for await (const wn of client.queryNodes({ type: 'CALL', name: '<obj>.action' })) {
    return wn;
  }
  return null;
}

/**
 * Seed the `cli:command` FEATURE node DIRECTLY in the derive-pack shape
 * (node metadata: anchorCall = the `.action` CALL's wire id, method = 'action',
 * library = 'commander') anchored on the seeded chain's `.action` call, then
 * invoke commanderExtractor on it. Returns the extractor's result. This mirrors
 * what js_entrypoint_features_nodes.dl mints — see the file header for the
 * enricher→pack migration (the #403 httpRouteExtractor reseed precedent).
 */
async function seedFeatureThenExtract(client, file) {
  const actionWire = await findActionCallWire(client);
  assert.ok(actionWire, 'the seeded chain must contain an <obj>.action CALL');
  const featureId = `${file}::cli:command::analyze::${actionWire.id}`;
  await client.addNodes([
    {
      id: featureId,
      nodeType: 'cli:command',
      name: 'analyze',
      file,
      exported: false,
      metadata: JSON.stringify({
        library: 'commander',
        method: 'action',
        anchorCall: actionWire.id,
      }),
    },
  ]);
  await client.addEdges([
    { src: actionWire.id, dst: featureId, edgeType: 'EXPOSES', metadata: JSON.stringify({}) },
  ]);
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

    const data = await seedFeatureThenExtract(client, 'cli.ts');
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

    const data = await seedFeatureThenExtract(client, 'cli.ts');
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

    const data = await seedFeatureThenExtract(client, 'cli.ts');
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

    const data = await seedFeatureThenExtract(client, 'cli.ts');
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

    const data = await seedFeatureThenExtract(client, 'cli.ts');
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

    const data = await seedFeatureThenExtract(client, 'cli.ts');
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

    const data = await seedFeatureThenExtract(client, 'cli.ts');
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

    const data = await seedFeatureThenExtract(client, 'cli.ts');
    assert.ok(data);
    assert.equal(data.description, 'Run analysis');
    assert.equal(data.outputs.length, 0);
  });

  it('multi-command: two independent FEATUREs each yield their own spec', async () => {
    // Two separate command chains in the same file. The derive pack mints two
    // cli:command FEATUREs (one per `.action` anchor); commanderExtractor must
    // extract each independently from its own anchor call. We seed both chains,
    // then mint the two FEATURE nodes DIRECTLY anchored on their `.action`
    // calls — the pack-emitted shape — matching each action to its chain's
    // command spec via the RECEIVER_CALL → chain-origin LITERAL (the same walk
    // the pack uses to name a cli:command from its chain-origin arg-0 literal).
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

    // For each seeded `.action` CALL, walk RECEIVER_CALL back to the chain
    // origin (`new Command('<spec>')`) and read its arg-0 LITERAL as the name,
    // then mint the FEATURE node anchored on the action call.
    for await (const action of client.queryNodes({ type: 'CALL', name: '<obj>.action' })) {
      let origin = action;
      for (let i = 0; i < 32; i++) {
        const recv = await client.getOutgoingEdges(origin.id, ['RECEIVER_CALL']);
        if (recv.length === 0) break;
        const inner = await client.getNode(String(recv[0].dst));
        if (!inner) break;
        origin = inner;
      }
      let name = '<unnamed-cli-command>';
      const args = await client.getOutgoingEdges(origin.id, ['PASSES_ARGUMENT']);
      for (const e of args) {
        if (Number((e).index) !== 0) continue;
        const lit = await client.getNode(String(e.dst));
        if (lit?.name) name = lit.name;
      }
      const fid = `multi.ts::cli:command::${name}::${action.id}`;
      await client.addNodes([
        {
          id: fid,
          nodeType: 'cli:command',
          name,
          file: 'multi.ts',
          exported: false,
          metadata: JSON.stringify({ library: 'commander', method: 'action', anchorCall: action.id }),
        },
      ]);
      await client.addEdges([
        { src: action.id, dst: fid, edgeType: 'EXPOSES', metadata: JSON.stringify({}) },
      ]);
    }

    const features = [];
    for await (const wn of client.queryNodes({ type: 'cli:command' })) features.push(wn);
    assert.equal(features.length, 2);

    const results = [];
    for (const feat of features) {
      const data = await commanderExtractor.extract(client, feat);
      assert.ok(data, `extractor should not return null for ${feat.name}`);
      results.push({ name: feat.name, data });
    }

    // The FEATURE name is the chain-origin arg-0 spec string (the pack's
    // origin-arg-0 fallback; the legacy enricher didn't split on whitespace
    // either). Match by `startsWith` to identify each command.
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
