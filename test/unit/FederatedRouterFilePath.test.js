import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { toGrafemaUri } from '@grafema/util';
// extractFilePath is an @internal helper — imported via the federation
// subpath so it stays off the top-level public barrel (mirrors extractSymbolFromId).
import { extractFilePath } from '@grafema/util/federation/index';

/**
 * Regression: extractFilePath must recover the SAME file path from BOTH wire
 * formats of a semantic ID — it must be wire-format-agnostic.
 *
 * FederatedRouter.groupByShard uses extractFilePath(edge.dst) and feeds the
 * result to ShardDiscovery.resolve(), which does longest-prefix matching of the
 * file path against absolute shard roots. Its sibling extractSymbolFromId was
 * upgraded to parse the grafema:// URI form; extractFilePath kept a naive URI
 * branch that sliced off only the "grafema://" scheme, leaving the URI AUTHORITY
 * (e.g. "localhost/proj" or "github.com/owner/repo") prepended to the path.
 *
 * The analysis pipeline's to_uri_format() emits ids as grafema:// URIs of the
 * form grafema://{authority}/{file}#{fragment} (GrafemaUri.toGrafemaUri). The old
 * branch therefore returned "localhost/proj/src/app.ts" instead of "src/app.ts",
 * so every URI-format edge mis-routed to the "__unresolved__" group: the
 * authority-prefixed string never startsWith() an absolute shard root.
 */
describe('FederatedRouter.extractFilePath', () => {
  it('extracts the file path from the arrow format (unchanged)', () => {
    assert.equal(extractFilePath('src/app.ts->FUNCTION->myFunc'), 'src/app.ts');
  });

  it('strips the authority from the grafema:// URI format (regression)', () => {
    const compact = 'src/app.ts->FUNCTION->myFunc';
    const uri = toGrafemaUri(compact, 'localhost/proj');
    // uri === 'grafema://localhost/proj/src/app.ts#FUNCTION-%3EmyFunc'
    assert.ok(uri.startsWith('grafema://') && !uri.includes('->'),
      `URI form must carry no literal '->': ${uri}`);
    // Format-agnostic: URI and arrow forms of the SAME node yield the SAME path.
    assert.equal(extractFilePath(uri), 'src/app.ts');
  });

  it('strips a 3-segment host/owner/repo authority', () => {
    const uri = toGrafemaUri('packages/api/src/x.ts->CLASS->Foo', 'github.com/owner/repo');
    assert.equal(extractFilePath(uri), 'packages/api/src/x.ts');
  });

  it('handles the MODULE URI form', () => {
    const uri = toGrafemaUri('MODULE#src/app.ts', 'localhost/proj');
    // uri === 'grafema://localhost/proj/src/app.ts#MODULE'
    assert.equal(extractFilePath(uri), 'src/app.ts');
  });

  it('returns null for empty input', () => {
    assert.equal(extractFilePath(''), null);
  });
});
