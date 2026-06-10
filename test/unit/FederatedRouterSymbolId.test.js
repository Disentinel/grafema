import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { toGrafemaUri } from '@grafema/util';
// extractSymbolFromId is an @internal helper — imported via the federation
// subpath so it stays off the top-level public barrel.
import { extractSymbolFromId } from '@grafema/util/federation/index';

/**
 * Regression: extractSymbolFromId must recover the symbol name from BOTH wire
 * formats of a semantic ID.
 *
 * FederatedRouter.tryManifestFallback uses extractSymbolFromId(edge.src) as the
 * last-resort symbol name when an IMPORTS_FROM edge carries no specifier/localName
 * in its metadata, then looks that name up in a package manifest. Its sibling
 * extractFilePath was upgraded to parse the grafema:// URI form, but
 * extractSymbolFromId kept an arrow-only `split('->')` path.
 *
 * The analysis pipeline's to_uri_format() emits ids as grafema:// URIs whose
 * fragment percent-encodes every '->' as '-%3E' (GrafemaUri.encodeFragment turns
 * '>' into '%3E'). So a URI-format id contains no literal '->', split('->')
 * yields a single part, and the old code returned null — silently degrading a
 * precise symbol-level manifest resolution to a wildcard '*'.
 */
describe('FederatedRouter.extractSymbolFromId', () => {
  const compact = 'src/app.ts->FUNCTION->myFunc';
  const uri = toGrafemaUri(compact, 'localhost/proj');

  it('extracts the symbol from the arrow format (unchanged)', () => {
    assert.equal(extractSymbolFromId(compact), 'myFunc');
  });

  it('extracts the symbol from the grafema:// URI format (regression)', () => {
    // uri === 'grafema://localhost/proj/src/app.ts#FUNCTION-%3EmyFunc'
    assert.ok(uri.startsWith('grafema://') && !uri.includes('->'),
      `URI form must carry no literal '->': ${uri}`);
    assert.equal(extractSymbolFromId(uri), 'myFunc');
  });

  it('strips bracket scope + disambiguation counter from URI-format ids', () => {
    const compactScoped = 'src/app.ts->FUNCTION->myFunc[in:src/app.ts->CLASS->Foo,h:ab12]#2';
    const uriScoped = toGrafemaUri(compactScoped, 'localhost/proj');
    assert.equal(extractSymbolFromId(uriScoped), 'myFunc');
  });

  it('returns null for empty input', () => {
    assert.equal(extractSymbolFromId(''), null);
  });

  it('returns null for an arrow id with fewer than three segments', () => {
    assert.equal(extractSymbolFromId('EXTERNAL_MODULE->lodash'), null);
  });
});
