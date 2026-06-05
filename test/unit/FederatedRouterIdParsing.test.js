/**
 * FederatedRouter semantic-ID parsing
 *
 * Regression coverage for the grafema:// URI bug class
 * (see .claude/skills/grafema-uri-semantic-id-parsing).
 *
 * After the analysis pipeline runs `to_uri_format()`, semantic IDs stored in
 * RFDB (and therefore carried on federation frontier edges) are grafema:// URIs
 * whose fragment encodes "->" as "-%3E" — NOT a literal "->". A naive
 * `id.split('->')` therefore yields a single segment and silently fails.
 *
 * The authoritative URI shape comes from the orchestrator producer
 * (packages/grafema-orchestrator/src/analyzer.rs):
 *   encode_fragment("FUNCTION->foo")                  == "FUNCTION-%3Efoo"
 *   compact_to_uri("src/app.js->FUNCTION->foo", auth) == "grafema://localhost/grafema/src/app.js#FUNCTION-%3Efoo"
 *
 * `extractFilePath` (sibling in the same file) was already hardened for both
 * formats; `extractSymbolFromId` was not. This test pins the symbol extractor
 * to the same dual-format contract.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { extractSymbolFromId } = await import('../../packages/util/dist/federation/FederatedRouter.js');

describe('extractSymbolFromId', () => {
  it('extracts the symbol from a grafema:// URI (standard node)', () => {
    // Authoritative shape from analyzer.rs test_compact_to_uri_standard_node
    assert.equal(
      extractSymbolFromId('grafema://localhost/grafema/src/app.js#FUNCTION-%3EmyFunc'),
      'myFunc',
    );
  });

  it('strips bracket disambiguators from a grafema:// URI', () => {
    // analyzer.rs test_compact_to_uri_with_brackets
    assert.equal(
      extractSymbolFromId('grafema://localhost/grafema/src/app.js#FUNCTION-%3Efoo%5Bin:bar%5D'),
      'foo',
    );
  });

  it('resolves a grafema:// virtual node (EXTERNAL_MODULE)', () => {
    // analyzer.rs test_compact_to_uri_external_module
    assert.equal(
      extractSymbolFromId('grafema://localhost/grafema/_/EXTERNAL_MODULE-%3Elodash'),
      'lodash',
    );
  });

  it('still extracts the symbol from a legacy arrow ID (no regression)', () => {
    assert.equal(extractSymbolFromId('src/app.js->FUNCTION->myFunc'), 'myFunc');
  });

  it('still extracts the symbol from a v1 scoped arrow ID (no regression)', () => {
    assert.equal(extractSymbolFromId('src/app.js->UserService->METHOD->login'), 'login');
  });

  it('returns null for empty input', () => {
    assert.equal(extractSymbolFromId(''), null);
  });
});
