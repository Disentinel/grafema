/**
 * rfdbCodec characterization tests (REG-490).
 *
 * RFDBServerBackend.ts (1035 lines) was split into a connection/data/query
 * class chain plus a pure codec module (rfdbCodec.ts). These tests lock the
 * behavior of the extracted wire-conversion / validation / parse / binding
 * helpers so the refactor is byte-for-byte faithful to the original inline
 * logic. They are server-free and deterministic (unlike the socket-based
 * test/unit/storage/backends/*.test.js, which spawn rfdb-server).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  toWireNode,
  toWireNodes,
  toWireEdge,
  toWireEdges,
  edgeTypeOf,
  parseWireNode,
  parseWireEdge,
  toBindingRows,
  validateInputNodes,
  validateInputEdges,
  resolveSocketPath,
} from '@grafema/util/storage/backends/rfdbCodec';

describe('rfdbCodec.toWireNode', () => {
  it('v3: stores original id as semanticId, metadata holds only extra fields', () => {
    const wire = toWireNode(
      { id: 'CLASS:Foo@f.ts', type: 'CLASS', name: 'Foo', file: 'f.ts', exported: true, custom: 'x' },
      true,
    );
    assert.strictEqual(wire.id, 'CLASS:Foo@f.ts');
    assert.strictEqual(wire.nodeType, 'CLASS');
    assert.strictEqual(wire.name, 'Foo');
    assert.strictEqual(wire.file, 'f.ts');
    assert.strictEqual(wire.exported, true);
    assert.strictEqual(wire.semanticId, 'CLASS:Foo@f.ts');
    assert.deepStrictEqual(JSON.parse(wire.metadata), { custom: 'x' });
  });

  it('v2: no semanticId, metadata carries originalId', () => {
    const wire = toWireNode({ id: 'n1', nodeType: 'FUNCTION', custom: 'x' }, false);
    assert.strictEqual(wire.semanticId, undefined);
    assert.strictEqual(wire.nodeType, 'FUNCTION');
    assert.deepStrictEqual(JSON.parse(wire.metadata), { originalId: 'n1', custom: 'x' });
  });

  it('nodeType precedence: nodeType > node_type > type > UNKNOWN', () => {
    assert.strictEqual(toWireNode({ id: 'a', nodeType: 'A', node_type: 'B', type: 'C' }, true).nodeType, 'A');
    assert.strictEqual(toWireNode({ id: 'a', node_type: 'B', type: 'C' }, true).nodeType, 'B');
    assert.strictEqual(toWireNode({ id: 'a', type: 'C' }, true).nodeType, 'C');
    assert.strictEqual(toWireNode({ id: 'a' }, true).nodeType, 'UNKNOWN');
  });

  it('toWireNodes maps a batch', () => {
    const wires = toWireNodes([{ id: 'a', type: 'X' }, { id: 'b', type: 'Y' }], true);
    assert.strictEqual(wires.length, 2);
    assert.strictEqual(wires[1].id, 'b');
  });
});

describe('rfdbCodec.toWireEdge', () => {
  it('addEdges v3 (batch=false): plain flat metadata, no _orig', () => {
    const wire = toWireEdge({ src: 'a', dst: 'b', type: 'CALLS', weight: 3 }, true, false);
    assert.strictEqual(wire.src, 'a');
    assert.strictEqual(wire.dst, 'b');
    assert.strictEqual(wire.edgeType, 'CALLS');
    assert.deepStrictEqual(JSON.parse(wire.metadata), { weight: 3 });
  });

  it('addEdges v2 (batch=false): metadata carries _origSrc/_origDst', () => {
    const wire = toWireEdge({ src: 'a', dst: 'b', type: 'CALLS', weight: 3 }, false, false);
    assert.deepStrictEqual(JSON.parse(wire.metadata), { _origSrc: 'a', _origDst: 'b', weight: 3 });
  });

  it('batch=true: never adds _orig, even on v2', () => {
    const v2 = toWireEdge({ src: 'a', dst: 'b', type: 'CALLS', weight: 3 }, false, true);
    assert.deepStrictEqual(JSON.parse(v2.metadata), { weight: 3 });
    const v3 = toWireEdge({ src: 'a', dst: 'b', type: 'CALLS', weight: 3 }, true, true);
    assert.deepStrictEqual(JSON.parse(v3.metadata), { weight: 3 });
  });

  it('nested metadata object is merged over rest', () => {
    const wire = toWireEdge({ src: 'a', dst: 'b', edgeType: 'READS', rest1: 1, metadata: { m: 2 } }, true, false);
    assert.deepStrictEqual(JSON.parse(wire.metadata), { rest1: 1, m: 2 });
  });

  it('edgeType precedence and UNKNOWN fallback', () => {
    assert.strictEqual(toWireEdge({ src: 'a', dst: 'b', edgeType: 'E', edge_type: 'F', etype: 'G', type: 'H' }, true, false).edgeType, 'E');
    assert.strictEqual(toWireEdge({ src: 'a', dst: 'b', edge_type: 'F' }, true, false).edgeType, 'F');
    assert.strictEqual(toWireEdge({ src: 'a', dst: 'b', etype: 'G' }, true, false).edgeType, 'G');
    assert.strictEqual(toWireEdge({ src: 'a', dst: 'b' }, true, false).edgeType, 'UNKNOWN');
  });

  it('toWireEdges maps a batch with addEdges semantics', () => {
    const wires = toWireEdges([{ src: 'a', dst: 'b', type: 'CALLS' }], false);
    assert.deepStrictEqual(JSON.parse(wires[0].metadata), { _origSrc: 'a', _origDst: 'b' });
  });
});

describe('rfdbCodec.edgeTypeOf', () => {
  it('resolves precedence and returns undefined when absent', () => {
    assert.strictEqual(edgeTypeOf({ src: 'a', dst: 'b', edgeType: 'E' }), 'E');
    assert.strictEqual(edgeTypeOf({ src: 'a', dst: 'b', edge_type: 'F' }), 'F');
    assert.strictEqual(edgeTypeOf({ src: 'a', dst: 'b', etype: 'G' }), 'G');
    assert.strictEqual(edgeTypeOf({ src: 'a', dst: 'b', type: 'H' }), 'H');
    assert.strictEqual(edgeTypeOf({ src: 'a', dst: 'b' }), undefined);
  });
});

describe('rfdbCodec.parseWireNode', () => {
  it('prefers metadata.semanticId over synthesized wireNode.semanticId', () => {
    const node = parseWireNode({
      id: 'rawid',
      nodeType: 'FUNCTION',
      name: 'f',
      file: 'a.ts',
      exported: false,
      semanticId: 'FUNCTION:f@a.ts',
      metadata: JSON.stringify({ semanticId: 'original-human-id', custom: 'v' }),
    });
    assert.strictEqual(node.id, 'original-human-id');
    assert.strictEqual(node.type, 'FUNCTION');
    assert.strictEqual(node.name, 'f');
    assert.strictEqual(node.custom, 'v');
  });

  it('does not let metadata overwrite standard fields (REG-325)', () => {
    const node = parseWireNode({
      id: 'x',
      nodeType: 'VARIABLE',
      name: 'realName',
      file: 'real.ts',
      exported: true,
      metadata: JSON.stringify({ name: 'EVIL', file: 'EVIL', type: 'EVIL' }),
    });
    assert.strictEqual(node.name, 'realName');
    assert.strictEqual(node.file, 'real.ts');
    assert.strictEqual(node.type, 'VARIABLE');
  });

  it('parses nested JSON string metadata values', () => {
    const node = parseWireNode({
      id: 'x',
      nodeType: 'FUNCTION',
      name: 'f',
      file: 'a.ts',
      exported: false,
      metadata: JSON.stringify({ params: '[1,2]', obj: '{"k":1}', plain: 'hello' }),
    });
    assert.deepStrictEqual(node.params, [1, 2]);
    assert.deepStrictEqual(node.obj, { k: 1 });
    assert.strictEqual(node.plain, 'hello');
  });

  it('falls back through originalId then raw id', () => {
    const viaOriginal = parseWireNode({
      id: 'rawid', nodeType: 'X', name: '', file: '', exported: false,
      metadata: JSON.stringify({ originalId: 'orig' }),
    });
    assert.strictEqual(viaOriginal.id, 'orig');
    const viaRaw = parseWireNode({ id: 'rawid', nodeType: 'X', name: '', file: '', exported: false, metadata: '' });
    assert.strictEqual(viaRaw.id, 'rawid');
  });
});

describe('rfdbCodec.parseWireEdge', () => {
  it('v3: uses wire src/dst directly', () => {
    const edge = parseWireEdge({ src: 'A', dst: 'B', edgeType: 'CALLS', metadata: JSON.stringify({ w: 1 }) }, 3);
    assert.strictEqual(edge.src, 'A');
    assert.strictEqual(edge.dst, 'B');
    assert.strictEqual(edge.type, 'CALLS');
    assert.deepStrictEqual(edge.metadata, { w: 1 });
  });

  it('v2: recovers original src/dst from metadata hack', () => {
    const edge = parseWireEdge({ src: 'hashA', dst: 'hashB', edgeType: 'CALLS', metadata: JSON.stringify({ _origSrc: 'A', _origDst: 'B', w: 1 }) }, 2);
    assert.strictEqual(edge.src, 'A');
    assert.strictEqual(edge.dst, 'B');
    assert.deepStrictEqual(edge.metadata, { w: 1 });
  });

  it('omits metadata when empty after stripping _orig fields', () => {
    const edge = parseWireEdge({ src: 'A', dst: 'B', edgeType: 'CALLS', metadata: JSON.stringify({ _origSrc: 'A', _origDst: 'B' }) }, 2);
    assert.strictEqual(edge.metadata, undefined);
  });
});

describe('rfdbCodec.toBindingRows', () => {
  it('converts {X:v} record bindings to [{name,value}] arrays', () => {
    const out = toBindingRows([{ bindings: { X: '1', Y: '2' } }, { bindings: {} }]);
    assert.deepStrictEqual(out, [
      { bindings: [{ name: 'X', value: '1' }, { name: 'Y', value: '2' }] },
      { bindings: [] },
    ]);
  });
});

describe('rfdbCodec.validateInputNodes', () => {
  it('throws on missing id', () => {
    assert.throws(() => validateInputNodes([{ type: 'X' }]), /missing required 'id' field/);
  });
  it('throws on missing type', () => {
    assert.throws(() => validateInputNodes([{ id: 'a' }]), /is missing type/);
  });
  it('accepts valid nodes', () => {
    assert.doesNotThrow(() => validateInputNodes([{ id: 'a', type: 'X' }, { id: 'b', node_type: 'Y' }]));
  });
});

describe('rfdbCodec.validateInputEdges', () => {
  it('throws on missing src with source hint', () => {
    assert.throws(() => validateInputEdges([{ dst: 'b', type: 'X', source: 'a' }]), /Did you mean 'src'/);
  });
  it('throws on missing dst with target hint', () => {
    assert.throws(() => validateInputEdges([{ src: 'a', type: 'X', target: 'b' }]), /Did you mean 'dst'/);
  });
  it('throws on missing edge type', () => {
    assert.throws(() => validateInputEdges([{ src: 'a', dst: 'b' }]), /is missing edge type/);
  });
  it('accepts valid edges', () => {
    assert.doesNotThrow(() => validateInputEdges([{ src: 'a', dst: 'b', type: 'CALLS' }]));
  });
});

describe('rfdbCodec.resolveSocketPath', () => {
  it('returns explicit socketPath when provided', () => {
    assert.strictEqual(resolveSocketPath({ socketPath: '/custom.sock' }), '/custom.sock');
  });
  it('derives sibling rfdb.sock from dbPath', () => {
    assert.strictEqual(resolveSocketPath({ dbPath: '/p/.grafema/graph.rfdb' }), '/p/.grafema/rfdb.sock');
  });
  it('falls back to /tmp/rfdb.sock with no options', () => {
    assert.strictEqual(resolveSocketPath({}), '/tmp/rfdb.sock');
  });
  it('uses a hashed /tmp path when the sibling socket would exceed SUN_LEN', () => {
    const deep = '/' + 'a'.repeat(200) + '/.grafema/graph.rfdb';
    const sock = resolveSocketPath({ dbPath: deep });
    assert.match(sock, /^\/tmp\/grafema-[0-9a-f]{12}\.sock$/);
  });
});
