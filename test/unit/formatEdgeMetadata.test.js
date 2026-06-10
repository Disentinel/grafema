/**
 * Tests for formatEdgeMetadata (NodeContext display helper).
 *
 * Regression: the argument position on PASSES_ARGUMENT / RECEIVES_ARGUMENT
 * edges is emitted by every analyzer under the metadata key `index` (verified
 * via a live cargo test on rust_analyzer). formatEdgeMetadata previously read
 * only `argIndex`, so the `[argN]` annotation never rendered in `grafema
 * context` / MCP get_context on real graphs. It now reads `index` (with a
 * legacy `argIndex` fallback).
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { formatEdgeMetadata } from '../../packages/util/dist/index.js';

describe('formatEdgeMetadata: PASSES_ARGUMENT / RECEIVES_ARGUMENT index', () => {
  it('renders [arg0] from metadata.index (the field analyzers emit)', () => {
    const out = formatEdgeMetadata({ type: 'PASSES_ARGUMENT', metadata: { index: 0 } });
    assert.strictEqual(out, '  [arg0]');
  });

  it('renders [arg2] for RECEIVES_ARGUMENT from metadata.index', () => {
    const out = formatEdgeMetadata({ type: 'RECEIVES_ARGUMENT', metadata: { index: 2 } });
    assert.strictEqual(out, '  [arg2]');
  });

  it('still renders from the legacy argIndex alias', () => {
    const out = formatEdgeMetadata({ type: 'PASSES_ARGUMENT', metadata: { argIndex: 1 } });
    assert.strictEqual(out, '  [arg1]');
  });

  it('renders nothing when no argument position is present', () => {
    const out = formatEdgeMetadata({ type: 'PASSES_ARGUMENT', metadata: {} });
    assert.strictEqual(out, '');
  });
});
