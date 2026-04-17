/**
 * React context + hooks for the `SceneApi` imperative handle.
 *
 * Why two hooks?
 *  - `useSceneApi()` for components that absolutely need the scene (panels
 *    that drive camera/flows/routes). Throws if the tree wasn't wrapped in
 *    a provider — catching bootstrap bugs at the nearest render, not as
 *    silent no-ops.
 *  - `useSceneApiOptional()` for code that gracefully degrades (e.g. a
 *    preview rendered outside the map), or for conditional effects that
 *    fire only after the scene mounts.
 *
 * The provider value can be `null` to cover the interval between app
 * mount and scene readiness; switching from `null` to a concrete api
 * triggers a normal React re-render for consumers.
 */

import { createContext, createElement, useContext, type ReactNode } from 'react';
import type { SceneApi } from './SceneApi';

const SceneApiContext = createContext<SceneApi | null>(null);

// Use `createElement` directly rather than JSX in this file so the module
// is runtime-agnostic: Vite/tsc use the automatic JSX runtime, but the
// node:test + tsx loader used by unit tests falls back to classic JSX
// (which rewrites `<Foo/>` to `React.createElement(...)` and requires an
// in-scope `React` binding). Avoiding JSX here dodges that mismatch
// without adding a React default import or a file-level pragma.
export function SceneApiProvider({
  api,
  children,
}: {
  api: SceneApi | null;
  children: ReactNode;
}) {
  return createElement(SceneApiContext.Provider, { value: api }, children);
}

/**
 * Read the scene api. Throws when no provider is mounted OR when the
 * provider is still priming with a `null` value — callers that must
 * tolerate that transient state should use `useSceneApiOptional` instead.
 */
export function useSceneApi(): SceneApi {
  const api = useContext(SceneApiContext);
  if (!api) throw new Error('useSceneApi called outside SceneApiProvider');
  return api;
}

/** Read the scene api or `null` if not yet available. */
export function useSceneApiOptional(): SceneApi | null {
  return useContext(SceneApiContext);
}
