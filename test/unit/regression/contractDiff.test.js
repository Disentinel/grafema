/**
 * Tests for contractDiff helper (REG-1117 Layer 2 helper).
 *
 * Pure-function tests over SpecedContractData. Severity rules verified for
 * each kind of change.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  diffContracts,
  contractDiffSize,
  contractBreakingCount,
  formatContractDiff,
} from '@grafema/util/regression/contractDiff';

const spec = (over = {}) => ({
  source: 'commander',
  inputs: [],
  outputs: [],
  errors: [],
  ...over,
});

describe('contractDiff: empty inputs', () => {
  it('two empty maps → no changes', () => {
    const d = diffContracts(new Map(), new Map());
    assert.equal(contractDiffSize(d), 0);
    assert.equal(contractBreakingCount(d), 0);
    assert.equal(formatContractDiff(d), 'No contract changes vs golden.');
  });
});

describe('contractDiff: feature add/remove', () => {
  it('feature in current only → added (minor severity)', () => {
    const d = diffContracts(new Map(), new Map([['x', spec()]]));
    assert.deepEqual(d.added, ['x']);
    assert.equal(d.removed.length, 0);
    assert.equal(contractBreakingCount(d), 0);
  });

  it('feature in golden only → removed (breaking)', () => {
    const d = diffContracts(new Map([['x', spec()]]), new Map());
    assert.deepEqual(d.removed, ['x']);
    assert.equal(contractBreakingCount(d), 1);
  });
});

describe('contractDiff: input changes', () => {
  it('added input → MINOR', () => {
    const golden = new Map([['x', spec({ inputs: [{ name: '--foo', type: 'string' }] })]]);
    const current = new Map([
      [
        'x',
        spec({
          inputs: [
            { name: '--foo', type: 'string' },
            { name: '--bar', type: 'number' },
          ],
        }),
      ],
    ]);
    const d = diffContracts(golden, current);
    assert.equal(d.changed.length, 1);
    assert.equal(d.changed[0].severity, 'MINOR');
    const delta = d.changed[0].inputs.find((i) => i.name === '--bar');
    assert.equal(delta.kind, 'added');
    assert.equal(delta.severity, 'MINOR');
  });

  it('removed input → BREAKING', () => {
    const golden = new Map([
      [
        'x',
        spec({
          inputs: [
            { name: '--foo', type: 'string' },
            { name: '--bar', type: 'number' },
          ],
        }),
      ],
    ]);
    const current = new Map([['x', spec({ inputs: [{ name: '--foo', type: 'string' }] })]]);
    const d = diffContracts(golden, current);
    assert.equal(d.changed[0].severity, 'BREAKING');
    const delta = d.changed[0].inputs.find((i) => i.name === '--bar');
    assert.equal(delta.kind, 'removed');
    assert.equal(delta.severity, 'BREAKING');
  });

  it('input type change → BREAKING', () => {
    const golden = new Map([['x', spec({ inputs: [{ name: '--foo', type: 'string' }] })]]);
    const current = new Map([['x', spec({ inputs: [{ name: '--foo', type: 'number' }] })]]);
    const d = diffContracts(golden, current);
    assert.equal(d.changed[0].severity, 'BREAKING');
    const delta = d.changed[0].inputs[0];
    assert.equal(delta.kind, 'typeChanged');
    assert.equal(delta.oldType, 'string');
    assert.equal(delta.newType, 'number');
  });

  it('optional → required (optional false) → BREAKING', () => {
    const golden = new Map([
      ['x', spec({ inputs: [{ name: '--foo', type: 'string', optional: true }] })],
    ]);
    const current = new Map([
      ['x', spec({ inputs: [{ name: '--foo', type: 'string', optional: false }] })],
    ]);
    const d = diffContracts(golden, current);
    const delta = d.changed[0].inputs.find((i) => i.kind === 'optionalityChanged');
    assert.equal(delta.severity, 'BREAKING');
  });

  it('required → optional → MINOR', () => {
    const golden = new Map([
      ['x', spec({ inputs: [{ name: '--foo', type: 'string', optional: false }] })],
    ]);
    const current = new Map([
      ['x', spec({ inputs: [{ name: '--foo', type: 'string', optional: true }] })],
    ]);
    const d = diffContracts(golden, current);
    const delta = d.changed[0].inputs.find((i) => i.kind === 'optionalityChanged');
    assert.equal(delta.severity, 'MINOR');
  });

  it('description-only change → no diff entry (cosmetic filtered)', () => {
    const golden = new Map([
      ['x', spec({ inputs: [{ name: '--foo', type: 'string', description: 'OLD' }] })],
    ]);
    const current = new Map([
      ['x', spec({ inputs: [{ name: '--foo', type: 'string', description: 'NEW' }] })],
    ]);
    const d = diffContracts(golden, current);
    assert.equal(d.changed.length, 0);
  });
});

describe('contractDiff: positional reorder (cli:command only)', () => {
  it('reorder of positional inputs in cli:command → BREAKING', () => {
    const golden = new Map([
      [
        'x',
        spec({
          inputs: [
            { name: 'src', type: 'string' },
            { name: 'dst', type: 'string' },
          ],
        }),
      ],
    ]);
    const current = new Map([
      [
        'x',
        spec({
          inputs: [
            { name: 'dst', type: 'string' },
            { name: 'src', type: 'string' },
          ],
        }),
      ],
    ]);
    const cat = new Map([['x', 'cli:command']]);
    const d = diffContracts(golden, current, cat);
    const reorders = d.changed[0].inputs.filter((i) => i.kind === 'reordered');
    assert.equal(reorders.length, 2);
    for (const r of reorders) assert.equal(r.severity, 'BREAKING');
  });

  it('reorder of flag inputs (-x, --foo) → ignored (no entries)', () => {
    const golden = new Map([
      [
        'x',
        spec({
          inputs: [
            { name: '--foo', type: 'string' },
            { name: '--bar', type: 'string' },
          ],
        }),
      ],
    ]);
    const current = new Map([
      [
        'x',
        spec({
          inputs: [
            { name: '--bar', type: 'string' },
            { name: '--foo', type: 'string' },
          ],
        }),
      ],
    ]);
    const cat = new Map([['x', 'cli:command']]);
    const d = diffContracts(golden, current, cat);
    assert.equal(d.changed.length, 0, 'flag reorder must not emit any change');
  });

  it('reorder of positional inputs in non-cli category → ignored', () => {
    const golden = new Map([
      [
        'x',
        spec({
          source: 'mcp-inputSchema',
          inputs: [
            { name: 'src', type: 'string' },
            { name: 'dst', type: 'string' },
          ],
        }),
      ],
    ]);
    const current = new Map([
      [
        'x',
        spec({
          source: 'mcp-inputSchema',
          inputs: [
            { name: 'dst', type: 'string' },
            { name: 'src', type: 'string' },
          ],
        }),
      ],
    ]);
    const cat = new Map([['x', 'mcp:tool']]);
    const d = diffContracts(golden, current, cat);
    assert.equal(d.changed.length, 0);
  });
});

describe('contractDiff: outputs and errors', () => {
  it('added output → BREAKING', () => {
    const golden = new Map([['x', spec()]]);
    const current = new Map([['x', spec({ outputs: [{ name: 'result', type: 'string' }] })]]);
    const d = diffContracts(golden, current);
    assert.equal(d.changed[0].severity, 'BREAKING');
    assert.equal(d.changed[0].outputs[0].kind, 'added');
  });

  it('removed output → BREAKING', () => {
    const golden = new Map([['x', spec({ outputs: [{ name: 'result', type: 'string' }] })]]);
    const current = new Map([['x', spec()]]);
    const d = diffContracts(golden, current);
    assert.equal(d.changed[0].outputs[0].kind, 'removed');
    assert.equal(d.changed[0].outputs[0].severity, 'BREAKING');
  });

  it('output type change → BREAKING', () => {
    const golden = new Map([['x', spec({ outputs: [{ name: 'r', type: 'string' }] })]]);
    const current = new Map([['x', spec({ outputs: [{ name: 'r', type: 'number' }] })]]);
    const d = diffContracts(golden, current);
    assert.equal(d.changed[0].outputs[0].kind, 'typeChanged');
    assert.equal(d.changed[0].outputs[0].severity, 'BREAKING');
  });

  it('added error → BREAKING', () => {
    const golden = new Map([['x', spec()]]);
    const current = new Map([['x', spec({ errors: [{ type: 'NotFoundError' }] })]]);
    const d = diffContracts(golden, current);
    assert.equal(d.changed[0].errors[0].kind, 'added');
    assert.equal(d.changed[0].errors[0].severity, 'BREAKING');
  });

  it('removed error → BREAKING', () => {
    const golden = new Map([['x', spec({ errors: [{ type: 'NotFoundError' }] })]]);
    const current = new Map([['x', spec()]]);
    const d = diffContracts(golden, current);
    assert.equal(d.changed[0].errors[0].kind, 'removed');
  });
});

describe('contractDiff: deterministic ordering', () => {
  it('changed list sorted by featureId; deltas sorted by name', () => {
    const golden = new Map([
      ['m', spec({ inputs: [{ name: '--zz', type: 'string' }] })],
      ['a', spec({ inputs: [{ name: '--bb', type: 'string' }] })],
    ]);
    const current = new Map([
      ['m', spec({ inputs: [{ name: '--zz', type: 'number' }] })],
      ['a', spec({ inputs: [{ name: '--bb', type: 'number' }] })],
    ]);
    const d = diffContracts(golden, current);
    assert.deepEqual(
      d.changed.map((c) => c.featureId),
      ['a', 'm'],
    );
  });
});

describe('contractDiff: v2 default / enum / format tracking (NOTE severity)', () => {
  it('default value flip → NOTE entry, no BREAKING/MINOR severity', () => {
    const golden = new Map([
      ['x', spec({ inputs: [{ name: '--watch', type: 'boolean', optional: true, default: true }] })],
    ]);
    const current = new Map([
      ['x', spec({ inputs: [{ name: '--watch', type: 'boolean', optional: true, default: false }] })],
    ]);
    const d = diffContracts(golden, current);
    const delta = d.changed[0].inputs.find((i) => i.kind === 'defaultChanged');
    assert.ok(delta, 'expected a defaultChanged entry');
    assert.equal(delta.severity, 'NOTE');
    assert.equal(delta.oldDefault, true);
    assert.equal(delta.newDefault, false);
    // No breaking changes from a default flip alone.
    assert.equal(contractBreakingCount(d), 0);
  });

  it('enum set changed → NOTE entry (order-insensitive)', () => {
    const golden = new Map([
      ['x', spec({ inputs: [{ name: 'kind', type: 'string', enum: ['a', 'b'] }] })],
    ]);
    const current = new Map([
      ['x', spec({ inputs: [{ name: 'kind', type: 'string', enum: ['a', 'b', 'c'] }] })],
    ]);
    const d = diffContracts(golden, current);
    const delta = d.changed[0].inputs.find((i) => i.kind === 'enumChanged');
    assert.ok(delta);
    assert.equal(delta.severity, 'NOTE');
  });

  it('enum permutation only → no diff (order-insensitive comparison)', () => {
    const golden = new Map([
      ['x', spec({ inputs: [{ name: 'kind', type: 'string', enum: ['a', 'b'] }] })],
    ]);
    const current = new Map([
      ['x', spec({ inputs: [{ name: 'kind', type: 'string', enum: ['b', 'a'] }] })],
    ]);
    const d = diffContracts(golden, current);
    assert.equal(d.changed.length, 0);
  });

  it('format changed → NOTE entry', () => {
    const golden = new Map([
      ['x', spec({ inputs: [{ name: 'email', type: 'string' }] })],
    ]);
    const current = new Map([
      ['x', spec({ inputs: [{ name: 'email', type: 'string', format: 'email' }] })],
    ]);
    const d = diffContracts(golden, current);
    const delta = d.changed[0].inputs.find((i) => i.kind === 'formatChanged');
    assert.ok(delta);
    assert.equal(delta.severity, 'NOTE');
    assert.equal(delta.newFormat, 'email');
  });
});

describe('contractDiff: contractBreakingCount counts only breaking', () => {
  it('breaking change + minor change → count = 1', () => {
    const golden = new Map([
      [
        'x',
        spec({
          inputs: [
            { name: '--foo', type: 'string' }, // will be removed → BREAKING
          ],
        }),
      ],
      [
        'y',
        spec({
          inputs: [{ name: '--bar', type: 'string' }],
        }),
      ],
    ]);
    const current = new Map([
      ['x', spec()], // --foo removed
      [
        'y',
        spec({
          inputs: [
            { name: '--bar', type: 'string' },
            { name: '--baz', type: 'string' }, // additive → MINOR
          ],
        }),
      ],
    ]);
    const d = diffContracts(golden, current);
    assert.equal(contractBreakingCount(d), 1);
  });
});
