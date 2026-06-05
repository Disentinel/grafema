/**
 * Regression test for `grafema who` caller-name resolution under v2 semantic IDs.
 *
 * Bug: `who` reported every caller as `<anonymous>`. It recovered the caller name
 * by string-splitting the CALL node's semantic id on `->` (a v1 assumption:
 * `file->SCOPE->TYPE->name`). After the analysis pipeline runs `to_uri_format()`,
 * persisted ids are grafema:// URIs (e.g.
 * `grafema://host/src/lib.rs#CALL-%3Etarget_fn%5Bin:...%5D`) that contain no
 * literal `->`, so the split yielded one segment and the scope-walk never ran.
 *
 * Reproduced live via `grafema analyze` on a Rust fixture: `grafema who target_fn`
 * listed two real callers (`caller_fn`, `another_caller`) both as `<anonymous>`.
 *
 * Fix: resolve the caller graph-natively by traversing the CALL node's incoming
 * CONTAINS edge to the enclosing FUNCTION/METHOD — independent of id encoding.
 *
 * The URI id shapes below are authoritative: they are the exact strings produced
 * by grafema-orchestrator `analyzer.rs::to_uri_format` (see its passing unit test
 * `test_compact_to_uri_call_with_dot_name`) and observed in the live repro.
 */

import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';
import { resolveCallerName } from '../../packages/cli/dist/commands/whoCaller.js';

after(cleanupAllTestDatabases);

const FILE = 'src/lib.rs';
// CALL enclosed by `caller_fn` — namedParent encodes a full path containing `->`,
// exactly as the native Rust analyzer emits it, so id-string parsing is doubly fragile.
const FN_CALLER = `grafema://localhost/who-repro/${FILE}#FUNCTION-%3Ecaller_fn`;
const CALL_TARGET =
  `grafema://localhost/who-repro/${FILE}#CALL-%3Etarget_fn%5Bin:/tmp/who-repro/${FILE}-%3EFUNCTION-%3Ecaller_fn,h:68e1%5D`;
// CALL at module scope — no enclosing function, so no CONTAINS edge from a FUNCTION/METHOD.
const CALL_TOPLEVEL = `grafema://localhost/who-repro/${FILE}#CALL-%3Etop_call%5Bh:aaaa%5D`;
// CALL nested inside an `if` block: FUNCTION nested_caller -> SCOPE block -> CALL.
// The enclosing function is two CONTAINS hops up, exercising the climb.
const FN_NESTED = `grafema://localhost/who-repro/${FILE}#FUNCTION-%3Enested_caller`;
const SCOPE_BLOCK = `grafema://localhost/who-repro/${FILE}#SCOPE-%3Eblock%5Bin:nested_caller,h:b0e9%5D`;
const CALL_NESTED =
  `grafema://localhost/who-repro/${FILE}#CALL-%3Etarget_fn%5Bin:nested_caller,h:3e5c%5D`;

describe('who: resolveCallerName (v2 URI ids)', () => {
  let db;
  let backend;

  before(async () => {
    db = await createTestDatabase();
    backend = db.backend;
    await backend.addNodes([
      { id: FN_CALLER, type: 'FUNCTION', name: 'caller_fn', file: FILE },
      { id: CALL_TARGET, type: 'CALL', name: 'target_fn', file: FILE },
      { id: CALL_TOPLEVEL, type: 'CALL', name: 'top_call', file: FILE },
      { id: FN_NESTED, type: 'FUNCTION', name: 'nested_caller', file: FILE },
      { id: SCOPE_BLOCK, type: 'SCOPE', name: 'block', file: FILE },
      { id: CALL_NESTED, type: 'CALL', name: 'target_fn', file: FILE },
    ]);
    await backend.addEdges([
      // Direct: enclosing function CONTAINS the call site.
      { src: FN_CALLER, dst: CALL_TARGET, type: 'CONTAINS' },
      // Nested: FUNCTION -> SCOPE block -> CALL.
      { src: FN_NESTED, dst: SCOPE_BLOCK, type: 'CONTAINS' },
      { src: SCOPE_BLOCK, dst: CALL_NESTED, type: 'CONTAINS' },
    ]);
  });

  after(async () => {
    if (db) await db.cleanup();
  });

  it('resolves the caller via the CONTAINS edge, not id string-splitting', async () => {
    const caller = await resolveCallerName(backend, CALL_TARGET);
    assert.equal(caller, 'caller_fn');
  });

  it('climbs through intermediate scopes to the enclosing function', async () => {
    const caller = await resolveCallerName(backend, CALL_NESTED);
    assert.equal(caller, 'nested_caller');
  });

  it('returns <anonymous> for a top-level call with no enclosing function', async () => {
    const caller = await resolveCallerName(backend, CALL_TOPLEVEL);
    assert.equal(caller, '<anonymous>');
  });
});
