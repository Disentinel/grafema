/**
 * SemanticId v2 — nested-parent (path-bearing `in:`) parsing regression.
 *
 * Bug: parseSemanticIdV2() rejected any v2 ID whose `[in:...]` namedParent
 * value itself contained '->'. The native Rust analyzer
 * (grafema-orchestrator/src/rust_analyzer.rs) emits exactly this for a CALL
 * nested inside a function body: the namedParent is the FULL parent semantic
 * id, e.g. `CALL->target_fn[in:/abs/src/lib.rs->FUNCTION->caller_fn,h:68e1]`.
 *
 * The v1-rejection heuristic (`if (rest.includes('->')) return null`) is meant
 * to reject legacy v1 IDs (file->scope->TYPE->name), whose extra '->' lives in
 * the path/name region — never inside the v2 metadata bracket. Checking the
 * whole `rest`, including bracket content, false-positived on legitimate v2
 * IDs and made parseSemanticIdV2() return null for every nested Rust CALL.
 *
 * Fix: the v1 check inspects only the name region (the part before `[in:...]`).
 * A v2 namedParent value may contain '->'; that is opaque to the parser.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseSemanticIdV2 } from '@grafema/util';

describe('parseSemanticIdV2 — path-bearing namedParent (nested Rust CALL)', () => {
  it('parses a compact v2 ID whose in: value is a full parent path', () => {
    const id = 'src/lib.rs->CALL->target_fn[in:/abs/src/lib.rs->FUNCTION->caller_fn,h:68e1]';
    const parsed = parseSemanticIdV2(id);
    assert.ok(parsed, 'expected a parsed result, got null');
    assert.equal(parsed.file, 'src/lib.rs');
    assert.equal(parsed.type, 'CALL');
    assert.equal(parsed.name, 'target_fn');
    assert.equal(parsed.namedParent, '/abs/src/lib.rs->FUNCTION->caller_fn');
    assert.equal(parsed.contentHash, '68e1');
  });

  it('parses the grafema:// URI form of the same nested CALL', () => {
    // Post-pipeline (to_uri_format) shape: '->' encoded as '-%3E', brackets as %5B/%5D
    const uri =
      'grafema://localhost/grafema/src/lib.rs#CALL-%3Etarget_fn%5Bin:/abs/src/lib.rs-%3EFUNCTION-%3Ecaller_fn,h:68e1%5D';
    const parsed = parseSemanticIdV2(uri);
    assert.ok(parsed, 'expected a parsed result, got null');
    assert.equal(parsed.file, 'src/lib.rs');
    assert.equal(parsed.type, 'CALL');
    assert.equal(parsed.name, 'target_fn');
    assert.equal(parsed.namedParent, '/abs/src/lib.rs->FUNCTION->caller_fn');
  });

  it('preserves the counter suffix alongside a path-bearing parent', () => {
    const id = 'src/lib.rs->CALL->foo[in:/a/b.rs->FUNCTION->bar,h:1234]#2';
    const parsed = parseSemanticIdV2(id);
    assert.ok(parsed, 'expected a parsed result, got null');
    assert.equal(parsed.name, 'foo');
    assert.equal(parsed.namedParent, '/a/b.rs->FUNCTION->bar');
    assert.equal(parsed.counter, 2);
  });

  it('still parses a bare-name in: value (regression guard)', () => {
    const parsed = parseSemanticIdV2('src/app.js->CALL->foo[in:bar,h:abcd]');
    assert.ok(parsed);
    assert.equal(parsed.name, 'foo');
    assert.equal(parsed.namedParent, 'bar');
    assert.equal(parsed.contentHash, 'abcd');
  });

  it('still rejects legacy v1 IDs (extra -> in the name region, no bracket)', () => {
    // v1: file->scope->TYPE->name — the '->' lives outside any bracket
    assert.equal(parseSemanticIdV2('src/app.js->MyService->METHOD->login'), null);
    assert.equal(parseSemanticIdV2('src/app.js->global->FUNCTION->processData'), null);
  });
});
