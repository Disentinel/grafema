/**
 * Unit tests for humanReadableId (packages/mcp/src/handlers/query-handlers.ts).
 *
 * humanReadableId builds the agent-facing `callers` / `parent` / `members`
 * labels in MCP query results. It must correctly parse the grafema:// semantic
 * ID URI form — including the disambiguation counter that computeSemanticIdV2
 * appends for hash collisions (`#N`, encoded as `%23N` in the URI fragment).
 *
 * Regression: the original implementation percent-decoded the WHOLE id first and
 * then split on the LAST '#'. For a disambiguated id the decoded counter ('#N')
 * became the chosen path/fragment boundary, so the label degraded to garbage like
 * `app.js#FN->a[in:x,h:ff00]` instead of `a (in x) in app.js`. The canonical
 * parser (packages/util/src/core/SemanticId.ts parseSemanticIdV2) splits on the
 * first '#' BEFORE decoding; humanReadableId must agree.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { humanReadableId } from '../src/handlers/query-handlers.js';

describe('humanReadableId — grafema:// URI semantic IDs', () => {
  it('control: a non-disambiguated FUNCTION id resolves to "name in file"', () => {
    assert.equal(
      humanReadableId('grafema://localhost/grafema/src/app.js#FUNCTION-%3Efoo'),
      'foo in app.js'
    );
  });

  it('disambiguation counter (%23N) does not corrupt a bracketed id', () => {
    // Fragment decodes to: FN->a[in:x,h:ff00]#1
    assert.equal(
      humanReadableId('grafema://localhost/grafema/src/app.js#FN-%3Ea%5Bin:x,h:ff00%5D%231'),
      'a (in x) in app.js'
    );
  });

  it('disambiguation counter (%23N) is stripped from a bare id', () => {
    // Fragment decodes to: FUNCTION->foo#1
    assert.equal(
      humanReadableId('grafema://localhost/grafema/src/app.js#FUNCTION-%3Efoo%231'),
      'foo in app.js'
    );
  });

  it('MODULE id (no node descriptor) resolves to the file name', () => {
    assert.equal(
      humanReadableId('grafema://localhost/grafema/src/app.js#MODULE'),
      'app.js'
    );
  });

  it('bracketed scope without a counter is unchanged', () => {
    assert.equal(
      humanReadableId('grafema://localhost/grafema/src/app.js#CALL-%3Elog%5Bin:handler,h:a3f2%5D'),
      'log (in handler) in app.js'
    );
  });

  it('empty input yields the "?" sentinel', () => {
    assert.equal(humanReadableId(''), '?');
  });
});
