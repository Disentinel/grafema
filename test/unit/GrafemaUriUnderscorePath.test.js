/**
 * Regression: grafema:// URIs whose file path contains a "_" path segment.
 *
 * The virtual-node marker "_" is a reserved path segment that appears
 * immediately after the authority (grafema://{authority}/_/{encoded_id}). It
 * MUST be detected at the authority boundary, NOT by scanning the whole string
 * for the substring "/_/". A real file path that contains a bare "_" segment
 * (e.g. src/_/util.ts) was previously misparsed as a virtual node, silently
 * corrupting the reconstructed semantic ID (round-tripped to "util.ts#..." and
 * parseSemanticIdV2 returned undefined file/type/name).
 *
 * Lives at the top level of test/unit/ so the CI `test:coverage` glob
 * (`test/unit/*.test.js`, non-recursive) actually gates it.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  toGrafemaUri,
  parseGrafemaUri,
  toCompactSemanticId,
  parseSemanticIdV2,
} from '@grafema/util';

describe('grafema:// URI with "_" file-path segment (regression)', () => {
  it('parseGrafemaUri keeps a "_" directory in the file path', () => {
    const parsed = parseGrafemaUri('grafema://localhost/grafema/src/_/util.ts#FUNCTION-%3Efoo');
    assert.ok(parsed);
    assert.equal(parsed.isVirtual, false);
    assert.equal(parsed.filePath, 'src/_/util.ts');
    assert.equal(parsed.semanticId, 'src/_/util.ts->FUNCTION->foo');
  });

  it('parseGrafemaUri handles multiple "_" segments', () => {
    const parsed = parseGrafemaUri('grafema://localhost/grafema/a/_/b/_/c.ts#FN-%3Ez');
    assert.ok(parsed);
    assert.equal(parsed.isVirtual, false);
    assert.equal(parsed.filePath, 'a/_/b/_/c.ts');
    assert.equal(parsed.semanticId, 'a/_/b/_/c.ts->FN->z');
  });

  it('parseGrafemaUri handles a "_" segment under github.com authority', () => {
    const parsed = parseGrafemaUri('grafema://github.com/owner/repo/src/_/util.ts#FUNCTION-%3Efoo');
    assert.ok(parsed);
    assert.equal(parsed.authority, 'github.com/owner/repo');
    assert.equal(parsed.filePath, 'src/_/util.ts');
    assert.equal(parsed.semanticId, 'src/_/util.ts->FUNCTION->foo');
  });

  it('parseGrafemaUri keeps a "_" directory for a MODULE node', () => {
    const parsed = parseGrafemaUri('grafema://localhost/grafema/src/_/a.ts#MODULE');
    assert.ok(parsed);
    assert.equal(parsed.isVirtual, false);
    assert.equal(parsed.filePath, 'src/_/a.ts');
    assert.equal(parsed.semanticId, 'MODULE#src/_/a.ts');
  });

  it('parseSemanticIdV2 parses a node whose file has a "_" segment', () => {
    const parsed = parseSemanticIdV2('grafema://localhost/grafema/src/_/util.ts#FUNCTION-%3Efoo');
    assert.ok(parsed);
    assert.equal(parsed.file, 'src/_/util.ts');
    assert.equal(parsed.type, 'FUNCTION');
    assert.equal(parsed.name, 'foo');
  });

  it('parseSemanticIdV2 parses a MODULE node whose file has a "_" segment', () => {
    const parsed = parseSemanticIdV2('grafema://localhost/grafema/src/_/a.ts#MODULE');
    assert.ok(parsed);
    assert.equal(parsed.file, 'src/_/a.ts');
    assert.equal(parsed.type, 'MODULE');
  });

  it('still parses genuine virtual nodes (marker right after authority)', () => {
    const parsed = parseGrafemaUri('grafema://localhost/grafema/_/EXTERNAL_MODULE-%3Elodash');
    assert.ok(parsed);
    assert.equal(parsed.isVirtual, true);
    assert.equal(parsed.semanticId, 'EXTERNAL_MODULE->lodash');
  });

  it('parseSemanticIdV2 still parses genuine virtual singleton nodes', () => {
    const parsed = parseSemanticIdV2('grafema://localhost/grafema/_/net:stdio-%3E__stdio__');
    assert.ok(parsed);
    assert.equal(parsed.type, 'SINGLETON');
    assert.equal(parsed.name, '__stdio__');
  });

  for (const compact of [
    'src/_/util.ts->FUNCTION->foo',
    'a/_/b/_/c.ts->FN->z',
    'src/_/helpers/x.ts->CLASS->C[in:p]',
    'MODULE#src/_/a.ts',
  ]) {
    it(`roundtrips through URI: ${compact}`, () => {
      const uri = toGrafemaUri(compact, 'localhost/grafema');
      assert.equal(toCompactSemanticId(uri), compact);
    });
  }
});
