/**
 * Tests for the shared getNodeDisplayName helper in @grafema/util
 * (packages/util/src/queries/NodeContext.ts).
 *
 * This is the display helper used by `grafema context` AND the MCP
 * `get_context` tool (the AI-agent surface). When a node's `name` is
 * missing or corrupt (a JSON metadata blob), the helper must derive a
 * human-readable name from the semantic ID rather than dumping the raw id.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { getNodeDisplayName } from '@grafema/util';

describe('getNodeDisplayName (@grafema/util)', () => {
  it('uses node.name when it is a clean value', () => {
    assert.strictEqual(
      getNodeDisplayName({ id: 'src/a.ts->FUNCTION->foo', type: 'FUNCTION', name: 'foo' }),
      'foo'
    );
  });

  it('renders anonymous functions as λ (unchanged special case)', () => {
    assert.strictEqual(
      getNodeDisplayName({ id: 'src/a.ts->FUNCTION->x', type: 'FUNCTION', name: '<arrow>' }),
      'λ'
    );
  });

  it('extracts the symbol name from a v2 compact id when name is corrupt', () => {
    const node = {
      id: 'src/auth/service.ts->FUNCTION->authenticate#2',
      type: 'FUNCTION',
      name: '{"originalId":"x","value":true}' // corrupt JSON → fallback
    };
    // Buggy behaviour returned the full id.
    assert.strictEqual(getNodeDisplayName(node), 'authenticate');
  });

  it('extracts the symbol name from a grafema:// URI when name is empty', () => {
    const node = {
      id: 'grafema://localhost/myproj/src/svc.ts#METHOD-%3Elogin%5Bin:UserService%5D%232',
      type: 'METHOD',
      name: ''
    };
    // Buggy behaviour returned the full URI.
    assert.strictEqual(getNodeDisplayName(node), 'login');
  });

  it('falls back to the full id when it is not a parseable semantic id', () => {
    const node = { id: '527103366', type: 'FUNCTION', name: '' };
    assert.strictEqual(getNodeDisplayName(node), '527103366');
  });
});
