import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  isGrafemaUri,
  encodeFragment,
  decodeFragment,
  toGrafemaUri,
  parseGrafemaUri,
  toCompactSemanticId,
} from '@grafema/util';
import { parseSemanticIdV2 } from '@grafema/util';

describe('GrafemaUri', () => {
  describe('isGrafemaUri', () => {
    it('returns true for grafema:// URIs', () => {
      assert.ok(isGrafemaUri('grafema://localhost/grafema/src/app.js#FUNCTION-%3Efoo'));
    });
    it('returns false for compact IDs', () => {
      assert.ok(!isGrafemaUri('src/app.js->FUNCTION->foo'));
    });
  });

  describe('encodeFragment / decodeFragment', () => {
    it('roundtrips > [ ] # characters', () => {
      const raw = 'CALL->c.log[in:x,h:a3f2]#1';
      assert.equal(decodeFragment(encodeFragment(raw)), raw);
    });
    it('encodes only the 4 special chars', () => {
      assert.equal(encodeFragment('FUNCTION->foo'), 'FUNCTION-%3Efoo');
      assert.equal(encodeFragment('name[in:bar]'), 'name%5Bin:bar%5D');
      assert.equal(encodeFragment('a#1'), 'a%231');
    });
    it('preserves allowed chars', () => {
      assert.equal(encodeFragment('name:with,commas-and.dots'), 'name:with,commas-and.dots');
    });
  });

  describe('toGrafemaUri', () => {
    it('converts standard file-based node', () => {
      assert.equal(
        toGrafemaUri('src/app.js->FUNCTION->foo', 'localhost/grafema'),
        'grafema://localhost/grafema/src/app.js#FUNCTION-%3Efoo'
      );
    });
    it('converts node with brackets', () => {
      assert.equal(
        toGrafemaUri('src/app.js->FUNCTION->foo[in:bar]', 'localhost/grafema'),
        'grafema://localhost/grafema/src/app.js#FUNCTION-%3Efoo%5Bin:bar%5D'
      );
    });
    it('converts node with hash counter', () => {
      assert.equal(
        toGrafemaUri('src/app.js->FN->a[in:x,h:ff00]#1', 'localhost/grafema'),
        'grafema://localhost/grafema/src/app.js#FN-%3Ea%5Bin:x,h:ff00%5D%231'
      );
    });
    it('converts CALL with dotted name', () => {
      assert.equal(
        toGrafemaUri('src/app.js->CALL->c.log[in:x,h:a3f2]', 'localhost/grafema'),
        'grafema://localhost/grafema/src/app.js#CALL-%3Ec.log%5Bin:x,h:a3f2%5D'
      );
    });
    it('converts MODULE#file', () => {
      assert.equal(
        toGrafemaUri('MODULE#src/app.js', 'localhost/grafema'),
        'grafema://localhost/grafema/src/app.js#MODULE'
      );
    });
    it('converts EXTERNAL_MODULE virtual node', () => {
      assert.equal(
        toGrafemaUri('EXTERNAL_MODULE->lodash', 'localhost/grafema'),
        'grafema://localhost/grafema/_/EXTERNAL_MODULE-%3Elodash'
      );
    });
    it('converts singleton virtual node', () => {
      assert.equal(
        toGrafemaUri('net:stdio->__stdio__', 'localhost/grafema'),
        'grafema://localhost/grafema/_/net:stdio-%3E__stdio__'
      );
    });
  });

  describe('parseGrafemaUri', () => {
    it('parses standard file-based URI', () => {
      const parsed = parseGrafemaUri('grafema://localhost/grafema/src/app.js#FUNCTION-%3Efoo');
      assert.ok(parsed);
      assert.equal(parsed.authority, 'localhost/grafema');
      assert.equal(parsed.filePath, 'src/app.js');
      assert.equal(parsed.symbolPart, 'FUNCTION->foo');
      assert.equal(parsed.semanticId, 'src/app.js->FUNCTION->foo');
      assert.equal(parsed.isVirtual, false);
    });
    it('parses MODULE URI', () => {
      const parsed = parseGrafemaUri('grafema://localhost/grafema/src/app.js#MODULE');
      assert.ok(parsed);
      assert.equal(parsed.semanticId, 'MODULE#src/app.js');
      assert.equal(parsed.isVirtual, false);
    });
    it('parses virtual node URI', () => {
      const parsed = parseGrafemaUri('grafema://localhost/grafema/_/EXTERNAL_MODULE-%3Elodash');
      assert.ok(parsed);
      assert.equal(parsed.semanticId, 'EXTERNAL_MODULE->lodash');
      assert.equal(parsed.isVirtual, true);
    });
    it('parses github.com authority (3 segments)', () => {
      const parsed = parseGrafemaUri('grafema://github.com/owner/repo/src/app.js#FUNCTION-%3Efoo');
      assert.ok(parsed);
      assert.equal(parsed.authority, 'github.com/owner/repo');
      assert.equal(parsed.filePath, 'src/app.js');
      assert.equal(parsed.semanticId, 'src/app.js->FUNCTION->foo');
    });
    it('returns null for non-grafema URLs', () => {
      assert.equal(parseGrafemaUri('https://example.com'), null);
    });
    it('returns null for compact IDs', () => {
      assert.equal(parseGrafemaUri('src/app.js->FUNCTION->foo'), null);
    });
  });

  describe('toCompactSemanticId', () => {
    it('converts URI to compact', () => {
      assert.equal(
        toCompactSemanticId('grafema://localhost/grafema/src/app.js#FUNCTION-%3Efoo'),
        'src/app.js->FUNCTION->foo'
      );
    });
    it('passes through compact IDs unchanged', () => {
      assert.equal(
        toCompactSemanticId('src/app.js->FUNCTION->foo'),
        'src/app.js->FUNCTION->foo'
      );
    });
  });

  describe('roundtrip: compact → URI → compact', () => {
    const cases = [
      'src/app.js->FUNCTION->foo',
      'src/app.js->FUNCTION->foo[in:bar]',
      'src/app.js->CALL->c.log[in:x,h:a3f2]',
      'src/app.js->FN->a[in:x,h:ff00]#1',
      'MODULE#src/app.js',
      'EXTERNAL_MODULE->lodash',
      'net:stdio->__stdio__',
      'src/deep/path/file.ts->CLASS->MyClass[in:ns,h:beef]#2',
    ];
    for (const compact of cases) {
      it(`roundtrips: ${compact}`, () => {
        const uri = toGrafemaUri(compact, 'localhost/grafema');
        const back = toCompactSemanticId(uri);
        assert.equal(back, compact);
      });
    }
  });

  describe('parseSemanticIdV2 with URI input', () => {
    it('parses standard URI', () => {
      const parsed = parseSemanticIdV2('grafema://localhost/grafema/src/app.js#FUNCTION-%3Efoo');
      assert.ok(parsed);
      assert.equal(parsed.file, 'src/app.js');
      assert.equal(parsed.type, 'FUNCTION');
      assert.equal(parsed.name, 'foo');
    });
    it('parses URI with brackets', () => {
      const parsed = parseSemanticIdV2('grafema://localhost/grafema/src/app.js#FUNCTION-%3Efoo%5Bin:bar%5D');
      assert.ok(parsed);
      assert.equal(parsed.file, 'src/app.js');
      assert.equal(parsed.type, 'FUNCTION');
      assert.equal(parsed.name, 'foo');
      assert.equal(parsed.namedParent, 'bar');
    });
    it('parses virtual node URI', () => {
      const parsed = parseSemanticIdV2('grafema://localhost/grafema/_/EXTERNAL_MODULE-%3Elodash');
      assert.ok(parsed);
      assert.equal(parsed.type, 'EXTERNAL_MODULE');
      assert.equal(parsed.name, 'lodash');
    });
    it('parses singleton URI', () => {
      const parsed = parseSemanticIdV2('grafema://localhost/grafema/_/net:stdio-%3E__stdio__');
      assert.ok(parsed);
      assert.equal(parsed.type, 'SINGLETON');
      assert.equal(parsed.name, '__stdio__');
    });
    it('parses MODULE URI', () => {
      const parsed = parseSemanticIdV2('grafema://localhost/grafema/src/app.js#MODULE');
      assert.ok(parsed);
      assert.equal(parsed.type, 'MODULE');
      assert.equal(parsed.file, 'src/app.js');
    });
  });

  describe('URL validation', () => {
    const uris = [
      'grafema://localhost/grafema/src/app.js#FUNCTION-%3Efoo',
      'grafema://localhost/grafema/src/app.js#MODULE',
      'grafema://localhost/grafema/_/EXTERNAL_MODULE-%3Elodash',
      'grafema://github.com/owner/repo/src/file.ts#CLASS-%3EMyClass',
    ];
    for (const uri of uris) {
      it(`is valid URL: ${uri}`, () => {
        assert.doesNotThrow(() => new URL(uri));
      });
    }
  });
});
