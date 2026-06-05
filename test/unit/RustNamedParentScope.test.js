/**
 * Rust namedParent scope normalization.
 *
 * The v2 semantic-ID spec intends the `[in:<namedParent>]` annotation to hold
 * the BARE name of the nearest named ancestor (e.g. `login`). The JS/Haskell
 * analyzers honor this, but the native Rust analyzer
 * (grafema-orchestrator/src/rust_analyzer.rs) emits the ancestor's FULL semantic
 * id instead, e.g. for a call inside `fn nested_caller`:
 *
 *   src/lib.rs->CALL->helper[in:src/lib.rs->FUNCTION->nested_caller,h:13f4]
 *
 * and for a call inside an `impl` method `Service::run`:
 *
 *   src/lib.rs->CALL->helper[in:src/lib.rs->FUNCTION->run[in:src/lib.rs->IMPL_BLOCK->Service],h:f63c]
 *
 * Consumers that DISPLAY namedParent (`who`, query's "inside X") or COMPARE it
 * against a bare scope name (`query`/`trace` `in:` filters) must tolerate both
 * shapes — otherwise Rust callers render as unreadable internal ids and
 * `--scope`/`in:` filters silently match nothing.
 *
 * These ID shapes were captured live from a real Rust graph (see PR description).
 *
 * Pure-function tests — no backend / no analyze required.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { matchesScope, extractScopeContext } from '../../packages/cli/dist/commands/query.js';
import { namedParentName } from '../../packages/util/dist/index.js';

// Real ID shapes captured from a native-Rust analysis (arrow form).
const RUST_CALL_IN_FUNCTION =
  'src/lib.rs->CALL->helper[in:src/lib.rs->FUNCTION->nested_caller,h:13f4]';
const RUST_CALL_IN_METHOD =
  'src/lib.rs->CALL->helper[in:src/lib.rs->FUNCTION->run[in:src/lib.rs->IMPL_BLOCK->Service],h:f63c]';
// JS/Haskell analyzers emit a BARE namedParent — must keep working unchanged.
const JS_CALL_IN_FUNCTION = 'src/app.ts->CALL->fetchData[in:login,h:ab12]';

describe('namedParentName — bare-name normalization', () => {
  it('passes a bare name through unchanged (JS/Haskell analyzers)', () => {
    assert.strictEqual(namedParentName('login'), 'login');
  });

  it('reduces a full FUNCTION semantic id to its leaf name (Rust)', () => {
    assert.strictEqual(
      namedParentName('src/lib.rs->FUNCTION->nested_caller'),
      'nested_caller'
    );
  });

  it('reduces a method id with a nested [in:..] annotation to the method name', () => {
    assert.strictEqual(
      namedParentName('src/lib.rs->FUNCTION->run[in:src/lib.rs->IMPL_BLOCK->Service]'),
      'run'
    );
  });

  it('falls back to the leaf segment for shapes the v2 parser rejects', () => {
    // A v1-style id (file->scope->TYPE->name) is not a valid v2 id; the
    // defensive fallback still yields the trailing segment.
    assert.strictEqual(namedParentName('a->b->c->leaf'), 'leaf');
  });
});

describe('matchesScope — Rust full-path namedParent (in: filter)', () => {
  it('matches a Rust function-scoped call by its bare ancestor name', () => {
    assert.strictEqual(
      matchesScope(RUST_CALL_IN_FUNCTION, null, ['nested_caller']),
      true,
      'a call inside fn nested_caller must match scope "nested_caller"'
    );
  });

  it('matches a Rust method-scoped call by its bare method name', () => {
    assert.strictEqual(
      matchesScope(RUST_CALL_IN_METHOD, null, ['run']),
      true,
      'a call inside method Service::run must match scope "run"'
    );
  });

  it('does not match an unrelated scope name', () => {
    assert.strictEqual(
      matchesScope(RUST_CALL_IN_FUNCTION, null, ['direct_caller']),
      false,
      'must not match a scope the call is not inside'
    );
  });

  it('keeps matching a JS bare-name namedParent (regression)', () => {
    assert.strictEqual(matchesScope(JS_CALL_IN_FUNCTION, null, ['login']), true);
  });
});

describe('extractScopeContext — Rust full-path namedParent (display)', () => {
  it('shows the bare ancestor name for a Rust function-scoped call', () => {
    assert.strictEqual(extractScopeContext(RUST_CALL_IN_FUNCTION), 'inside nested_caller');
  });

  it('shows the bare method name for a Rust method-scoped call', () => {
    assert.strictEqual(extractScopeContext(RUST_CALL_IN_METHOD), 'inside run');
  });

  it('keeps showing the bare JS name unchanged (regression)', () => {
    assert.strictEqual(extractScopeContext(JS_CALL_IN_FUNCTION), 'inside login');
  });
});
