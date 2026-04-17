/**
 * Unit tests for viewStore (C-viewStore-mode).
 *
 * viewStore holds the per-view UI state: active lens, enabled flow
 * presets, hovered tile, pins, selection, and the current SceneMode.
 *
 * This suite locks:
 *   - The initial SceneMode is DEFAULT_3D_MODE (structural equality, not
 *     reference equality — so consumers that import DEFAULT_3D_MODE and
 *     compare deep-wise still work).
 *   - `setMode(next)` updates state when next differs from current.
 *   - `setMode(next)` short-circuits (no subscriber notification) when
 *     next is deep-equal to current — even if next is a fresh object.
 *     This is the idempotent-guard contract required by SceneManager.
 *   - `selectedIdx` derivation: a selector that mirrors the first
 *     element of `selection` (or null when empty) so Canvas.tsx can
 *     migrate from its local `number` to the store-backed Set
 *     incrementally.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  useViewStore,
  selectSelectedIdx,
} from '../../../src/store/viewStore.ts';
import {
  DEFAULT_2D_MODE,
  DEFAULT_3D_MODE,
  type SceneMode,
} from '../../../src/three/types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Reset the store to a known baseline before each test. */
function resetStore(): void {
  useViewStore.setState({
    lens: 'default',
    enabledFlows: new Set(['bridges']),
    hoveredTile: -1,
    pins: new Map(),
    selection: new Set(),
    mode: DEFAULT_3D_MODE,
  });
}

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

describe('viewStore — initial state', () => {
  beforeEach(resetStore);

  it('defaults to DEFAULT_3D_MODE (deep-equal, not reference)', () => {
    const mode = useViewStore.getState().mode;
    assert.equal(mode.kind, '3d');
    assert.equal(mode.projection, 'perspective');
    assert.equal(mode.version, 1);
    assert.deepEqual(mode.cameraUp, DEFAULT_3D_MODE.cameraUp);
  });
});

// ---------------------------------------------------------------------------
// setMode — happy path
// ---------------------------------------------------------------------------

describe('viewStore.setMode — applies changes', () => {
  beforeEach(resetStore);

  it('setMode(DEFAULT_2D_MODE) updates mode and notifies subscribers once', () => {
    let notifications = 0;
    const unsub = useViewStore.subscribe(() => {
      notifications += 1;
    });

    useViewStore.getState().setMode(DEFAULT_2D_MODE);

    assert.equal(useViewStore.getState().mode.kind, '2d');
    assert.equal(
      notifications,
      1,
      'changing mode should notify subscribers exactly once',
    );
    unsub();
  });

  it('setMode with a partial change (same kind, new background) still applies', () => {
    const tweaked: SceneMode = { ...DEFAULT_3D_MODE, background: 0x112233 };
    useViewStore.getState().setMode(tweaked);
    assert.equal(useViewStore.getState().mode.background, 0x112233);
  });

  it('setMode with changed kind flips the mode even if other fields match', () => {
    // Start from a known state, then pass a mode with only `kind` flipped
    // but otherwise identical — sceneModesEqual must treat this as
    // distinct (kind is structural).
    const current = useViewStore.getState().mode;
    const flipped: SceneMode = { ...current, kind: '2d' };

    let notifications = 0;
    const unsub = useViewStore.subscribe(() => {
      notifications += 1;
    });

    useViewStore.getState().setMode(flipped);
    assert.equal(useViewStore.getState().mode.kind, '2d');
    assert.equal(notifications, 1);
    unsub();
  });
});

// ---------------------------------------------------------------------------
// setMode — idempotent guard
// ---------------------------------------------------------------------------

describe('viewStore.setMode — idempotent guard', () => {
  beforeEach(resetStore);

  it('setMode with identical reference does NOT notify subscribers', () => {
    const current = useViewStore.getState().mode;

    let notifications = 0;
    const unsub = useViewStore.subscribe(() => {
      notifications += 1;
    });

    useViewStore.getState().setMode(current);
    assert.equal(
      notifications,
      0,
      'identical reference must short-circuit without notification',
    );
    unsub();
  });

  it('setMode with a fresh-but-deep-equal object does NOT notify', () => {
    const current = useViewStore.getState().mode;
    // Fresh object + fresh tuple — Object.is fails but deep-equal holds.
    const copy: SceneMode = {
      ...current,
      cameraUp: [...current.cameraUp] as [number, number, number],
    };

    let notifications = 0;
    const unsub = useViewStore.subscribe(() => {
      notifications += 1;
    });

    useViewStore.getState().setMode(copy);
    assert.equal(
      notifications,
      0,
      'deep-equal object must short-circuit without notification',
    );
    unsub();
  });

  it('setMode({...current, kind: "2d"}) notifies (structural difference)', () => {
    const current = useViewStore.getState().mode;
    const flipped: SceneMode = { ...current, kind: '2d' };

    let notifications = 0;
    const unsub = useViewStore.subscribe(() => {
      notifications += 1;
    });

    useViewStore.getState().setMode(flipped);
    assert.equal(notifications, 1);
    unsub();
  });
});

// ---------------------------------------------------------------------------
// selectedIdx derivation
// ---------------------------------------------------------------------------

describe('viewStore.selectSelectedIdx — derived from selection Set', () => {
  beforeEach(resetStore);

  it('empty selection → null', () => {
    const state = useViewStore.getState();
    assert.equal(selectSelectedIdx(state), null);
  });

  it('single-element selection → that element', () => {
    useViewStore.getState().setSelection(new Set([42]));
    const state = useViewStore.getState();
    assert.equal(selectSelectedIdx(state), 42);
  });

  it('multi-element selection → first iteration element', () => {
    // Documented contract: Sets iterate in insertion order. We insert 7
    // first, so the derived value is 7.
    const multi = new Set<number>();
    multi.add(7);
    multi.add(13);
    multi.add(21);
    useViewStore.getState().setSelection(multi);

    const state = useViewStore.getState();
    assert.equal(
      selectSelectedIdx(state),
      7,
      'derivation returns first iteration element (insertion order)',
    );
  });

  it('clearSelection() → selectedIdx becomes null again', () => {
    useViewStore.getState().setSelection(new Set([99]));
    assert.equal(selectSelectedIdx(useViewStore.getState()), 99);

    useViewStore.getState().clearSelection();
    assert.equal(selectSelectedIdx(useViewStore.getState()), null);
  });
});
