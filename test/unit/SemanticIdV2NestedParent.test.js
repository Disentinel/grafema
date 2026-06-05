import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseSemanticIdV2, computeSemanticIdV2 } from '@grafema/util';

/**
 * Regression: parseSemanticIdV2 must accept v2 IDs whose `in:` namedParent value
 * itself contains '->'.
 *
 * The native Rust analyzer (packages/grafema-orchestrator/src/rust_analyzer.rs)
 * stores the FULL enclosing-function semantic ID in the `in:` bracket
 * (ctx.enclosing_fn = a `file->FUNCTION->name` node id), so every nested CALL /
 * REFERENCE / PROPERTY_ACCESS / LITERAL node id looks like:
 *
 *   src/lib.rs->CALL->target_fn[in:src/lib.rs->FUNCTION->caller_fn,h:68e1]
 *
 * The old v1-rejection guard (`if (rest.includes('->')) return null`) inspected
 * the ENTIRE remainder including the bracket content, so it false-rejected these
 * legitimate v2 IDs and returned null — silently disabling every downstream
 * consumer (matchesScope / extractScopeContext / FederatedRouter fallback /
 * trace scope filter) for nested native-analyzer nodes.
 *
 * The guard must only reject a v1 NAME region (file->scope->TYPE->name); the v2
 * `in:` value is opaque and may contain '->'.
 */
describe('parseSemanticIdV2 — namedParent containing "->" (native Rust analyzer shape)', () => {
  it('parses a nested CALL whose in: value is a full parent semantic ID', () => {
    const id = 'src/lib.rs->CALL->target_fn[in:src/lib.rs->FUNCTION->caller_fn,h:68e1]';
    const parsed = parseSemanticIdV2(id);
    assert.ok(parsed, 'expected a parse result, got null');
    assert.equal(parsed.file, 'src/lib.rs');
    assert.equal(parsed.type, 'CALL');
    assert.equal(parsed.name, 'target_fn');
    assert.equal(parsed.namedParent, 'src/lib.rs->FUNCTION->caller_fn');
    assert.equal(parsed.contentHash, '68e1');
  });

  it('parses the grafema:// URI form of the same nested CALL', () => {
    // Fragment encodes '->' as '-%3E', '[' as '%5B', ']' as '%5D'.
    const uri =
      'grafema://localhost/grafema/src/lib.rs#CALL-%3Etarget_fn%5Bin:src/lib.rs-%3EFUNCTION-%3Ecaller_fn,h:68e1%5D';
    const parsed = parseSemanticIdV2(uri);
    assert.ok(parsed, 'expected a parse result for URI form, got null');
    assert.equal(parsed.file, 'src/lib.rs');
    assert.equal(parsed.type, 'CALL');
    assert.equal(parsed.name, 'target_fn');
    assert.equal(parsed.namedParent, 'src/lib.rs->FUNCTION->caller_fn');
    assert.equal(parsed.contentHash, '68e1');
  });

  it('parses a nested CALL with a trailing counter suffix', () => {
    const id = 'src/lib.rs->CALL->target_fn[in:src/lib.rs->FUNCTION->caller_fn,h:68e1]#2';
    const parsed = parseSemanticIdV2(id);
    assert.ok(parsed, 'expected a parse result, got null');
    assert.equal(parsed.name, 'target_fn');
    assert.equal(parsed.namedParent, 'src/lib.rs->FUNCTION->caller_fn');
    assert.equal(parsed.contentHash, '68e1');
    assert.equal(parsed.counter, 2);
  });

  it('round-trips computeSemanticIdV2 with a full-path namedParent', () => {
    const parent = 'src/lib.rs->FUNCTION->caller_fn';
    const id = computeSemanticIdV2('CALL', 'target_fn', 'src/lib.rs', parent, 'abcd');
    const parsed = parseSemanticIdV2(id);
    assert.ok(parsed, 'expected encode→parse to round-trip, got null');
    assert.equal(parsed.namedParent, parent);
    assert.equal(parsed.name, 'target_fn');
  });

  it('still rejects genuine v1 IDs (extra "->" in the NAME region)', () => {
    // v1 shape: file->scope->TYPE->name — the remainder name region has '->'.
    assert.equal(parseSemanticIdV2('src/lib.rs->myScope->FUNCTION->foo'), null);
    assert.equal(parseSemanticIdV2('src/lib.rs->s1->s2->CALL->foo'), null);
  });

  it('preserves existing bare-name in: behavior', () => {
    const parsed = parseSemanticIdV2('src/app.js->CALL->foo[in:bar]');
    assert.ok(parsed);
    assert.equal(parsed.namedParent, 'bar');
    assert.equal(parsed.name, 'foo');
  });
});
