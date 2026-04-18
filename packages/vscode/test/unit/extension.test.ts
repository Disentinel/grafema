/**
 * Unit tests for extension.ts — DAI-17 (grafema.openMap auto-start).
 *
 * We avoid booting the full VS Code extension host here: activation wires
 * dozens of providers with side effects. Instead we assert structural
 * invariants on the source that lock the DAI-17 contract in place:
 *
 *   - The `grafema.openMap` handler is `async`.
 *   - It calls `clientManager.startServer()` before `MapPanel.createOrShow()`.
 *   - On startup failure it shows a warning message instead of silently
 *     hanging.
 *
 * If the handler is ever simplified back to a fire-and-forget
 * `createOrShow()`, these assertions fail loudly — catching the regression
 * REG-1100/DAI-17 was created to prevent.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SOURCE_PATH = join(__dirname, '..', '..', 'src', 'extension.ts');
const source = readFileSync(SOURCE_PATH, 'utf-8');

/** Extract the body of the `grafema.openMap` command registration so the
 * assertions below are scoped to that handler and don't accidentally match
 * unrelated code elsewhere in extension.ts. */
function extractOpenMapHandler(): string {
  const start = source.indexOf("registerCommand('grafema.openMap'");
  assert.ok(start >= 0, 'grafema.openMap command registration must exist');
  // Find the closing ')); of the registerCommand call.
  const endMarker = '}));';
  const end = source.indexOf(endMarker, start);
  assert.ok(end > start, 'openMap handler must be properly closed');
  return source.slice(start, end + endMarker.length);
}

describe('extension.ts — grafema.openMap (DAI-17)', () => {
  const handler = extractOpenMapHandler();

  it('openMap handler is async', () => {
    assert.match(
      handler,
      /registerCommand\('grafema\.openMap',\s*async\s*\(/,
      `openMap must be async for startServer() auto-start flow:\n${handler}`,
    );
  });

  it('openMap calls clientManager.startServer() before MapPanel.createOrShow()', () => {
    const startIdx = handler.indexOf('startServer()');
    const createIdx = handler.indexOf('MapPanel.createOrShow()');
    assert.ok(startIdx >= 0, 'openMap handler should call clientManager.startServer()');
    assert.ok(createIdx >= 0, 'openMap handler should call MapPanel.createOrShow()');
    assert.ok(
      startIdx < createIdx,
      `startServer() must run before createOrShow() — DAI-17 acceptance:\n${handler}`,
    );
  });

  it('openMap shows a warning on failure (no silent 60s hang)', () => {
    assert.match(
      handler,
      /showWarningMessage/,
      `openMap must surface failures via showWarningMessage instead of silently letting MapPanel poll for 60s:\n${handler}`,
    );
  });

  it('openMap bounds readiness polling (uses a deadline, not infinite wait)', () => {
    // DAI-17 cap: 10s. Asserting the magic number protects against drift
    // toward "poll forever" on startup failures.
    assert.match(
      handler,
      /10_?000/,
      `openMap should bound readiness polling (expected a 10_000 ms deadline):\n${handler}`,
    );
  });
});
