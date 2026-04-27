import * as React from 'react';
import { useViewStore } from '../store/viewStore';

// isolatedModules quirk: under the classic JSX runtime used by the
// node:test + tsx loader, JSX desugars to `React.createElement(...)`
// which needs `React` in scope. Vite's automatic runtime imports it
// implicitly, so the `void React` pattern is load-bearing for tests.
void React;

/** Heightmap multiplier applied when the user picks the City view. */
const CITY_MULT = 1.5;

/** Two view modes — Flat (heightmap off) vs City (columns on). */
export type ViewKind = 'flat' | 'city';

/**
 * Map heightMultiplier → view kind. >0 means columns are extruded
 * (City). Exactly 0 collapses every column to a flat disc (Flat).
 */
export function resolveActiveKind(mult: number): ViewKind {
  return mult > 0 ? 'city' : 'flat';
}

/**
 * Click handler — flip heightMultiplier between 0 (Flat) and CITY_MULT
 * (City). Exported for tests that want to assert store effects without
 * mounting the component.
 */
export function handleViewClick(kind: ViewKind): void {
  const next = kind === 'flat' ? 0 : CITY_MULT;
  useViewStore.getState().setHeightMultiplier(next);
}

/**
 * Two-button Flat / City toggle. Replaces the old 2D/3D mode switcher
 * (which had per-mode bugs around camera + bloom that aren't worth
 * fixing for the demo). Same position + styling as before so existing
 * layout assumptions stay intact.
 */
export function ModeToggle() {
  const mult = useViewStore((s) => s.heightMultiplier);
  const active = resolveActiveKind(mult);

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
        onClick={() => handleViewClick('flat')}
        style={btnStyle(active === 'flat')}
        data-active={active === 'flat' ? 'true' : 'false'}
        aria-pressed={active === 'flat'}
        aria-label="Switch to Flat view"
      >
        Flat
      </button>
      <button
        type="button"
        onClick={() => handleViewClick('city')}
        style={btnStyle(active === 'city')}
        data-active={active === 'city' ? 'true' : 'false'}
        aria-pressed={active === 'city'}
        aria-label="Switch to City view"
      >
        City
      </button>
    </div>
  );
}

export default ModeToggle;
