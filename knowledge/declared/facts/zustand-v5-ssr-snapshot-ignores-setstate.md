---
id: kb:fact:zustand-v5-ssr-snapshot-ignores-setstate
type: FACT
confidence: high
subtype: error
projections:
  - epistemic
created: 2026-04-17
---

## Zustand v5 uses getInitialState() for useSyncExternalStore's getServerSnapshot — setState calls in SSR tests are ignored

### Fact
Testing a Zustand-backed React component via `react-dom/server.renderToString`: `useStore.setState({ ... })` calls BEFORE `renderToString` do NOT affect what SSR renders. The component always sees the INITIAL store state, no matter how many setState updates happened.

### Root cause
Zustand v5 implements `useSyncExternalStore`'s `getServerSnapshot` callback as `getInitialState()`. SSR render path calls that, not the current state. `setState` mutations live in the runtime state slot, not the snapshot slot.

### Diagnostic signature
Test expectation: "after `setMode(X)`, Sidebar renders `Zoom:`". Test result: renders `Distance:` (initial 3D mode). Despite `setMode` being called correctly (verified via `useStore.getState()` → correct mode).

Hit in Phase 5a C-viewStore-mode when testing `Sidebar.test.tsx`.

### Fix
- Extract pure helpers (`formatViewReadout(mode, cameraDistance, zoom)`) and unit-test them directly — no React/SSR in the loop.
- Keep a smoke `renderToString(<Sidebar/>)` test only to verify the component mounts without crashing.
- If behavioral testing with real state transitions is needed, use `happy-dom` or `jsdom` + actual React client rendering, not `renderToString`.
