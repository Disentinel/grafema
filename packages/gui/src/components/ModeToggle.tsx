import * as React from 'react';
import { useViewStore } from '../store/viewStore';
import { DEFAULT_2D_MODE, DEFAULT_3D_MODE, type SceneMode } from '../three/types';

// isolatedModules quirk: under the classic JSX runtime used by the
// node:test + tsx loader, JSX desugars to `React.createElement(...)`
// which needs `React` in scope. Vite's automatic runtime imports it
// implicitly, so the `void React` pattern is load-bearing for tests.
void React;

/**
 * Returns the active kind from a SceneMode — trivial accessor, kept
 * as a pure helper so tests don't need to mount the component to
 * verify the active-state visual contract.
 */
export function resolveActiveKind(mode: SceneMode): '2d' | '3d' {
  return mode.kind;
}

/**
 * Click handler body — the exact logic that fires when a user presses
 * the "2D" or "3D" button. Exported for unit tests so we can assert
 * store effects without mounting.
 *
 * Relies on viewStore.setMode's idempotent guard: passing the currently
 * active mode is a complete no-op (no subscriber notification). That
 * keeps the handler safe against re-renders / double-clicks.
 */
export function handleModeClick(kind: '2d' | '3d'): void {
  const next = kind === '2d' ? DEFAULT_2D_MODE : DEFAULT_3D_MODE;
  useViewStore.getState().setMode(next);
}

/**
 * Two-button 2D / 3D toggle. Positioned absolute top-right inside
 * HexAtlas; styling matches existing panels (translucent dark, cyan
 * accent) without introducing a new design system.
 *
 * No keyboard shortcut (yet) — the surface is small enough that
 * adding one is best left to the host page, which owns the key map.
 */
export function ModeToggle() {
  const mode = useViewStore((s) => s.mode);
  const active = resolveActiveKind(mode);

  const btnStyle = (isActive: boolean): React.CSSProperties => ({
    padding: '4px 10px',
    fontSize: 11,
    fontFamily: "'JetBrains Mono', monospace",
    letterSpacing: '0.06em',
    borderRadius: 4,
    border: isActive ? '1px solid #00e5ff' : '1px solid #333',
    background: isActive ? '#00e5ff22' : 'rgba(6, 10, 16, 0.75)',
    color: isActive ? '#00e5ff' : '#888',
    cursor: 'pointer',
    backdropFilter: 'blur(10px)',
    WebkitBackdropFilter: 'blur(10px)',
  });

  return (
    <div
      style={{
        position: 'absolute',
        top: 12,
        right: 12,
        zIndex: 40,
        display: 'flex',
        gap: 4,
      }}
    >
      <button
        type="button"
        onClick={() => handleModeClick('2d')}
        style={btnStyle(active === '2d')}
        data-active={active === '2d' ? 'true' : 'false'}
        aria-pressed={active === '2d'}
        aria-label="Switch to 2D"
      >
        2D
      </button>
      <button
        type="button"
        onClick={() => handleModeClick('3d')}
        style={btnStyle(active === '3d')}
        data-active={active === '3d' ? 'true' : 'false'}
        aria-pressed={active === '3d'}
        aria-label="Switch to 3D"
      >
        3D
      </button>
    </div>
  );
}

export default ModeToggle;
