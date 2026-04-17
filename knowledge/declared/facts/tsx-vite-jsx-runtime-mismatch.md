---
id: kb:fact:tsx-vite-jsx-runtime-mismatch
type: FACT
confidence: high
subtype: error
projections:
  - epistemic
created: 2026-04-17
---

## tsx Node loader uses classic JSX runtime; Vite uses automatic — same .tsx source, different behavior

### Fact
A `.tsx` file that uses JSX syntax but imports only named exports from `react` (e.g. `import { createContext, useContext } from 'react'`):

- **Vite build**: passes. Its plugin-react uses React 17+ **automatic** JSX runtime — injects `import { jsx as _jsx } from 'react/jsx-runtime'` implicitly. No `import React` needed.
- **`tsx` Node loader** (`node --import tsx --test`): fails at runtime with `ReferenceError: React is not defined`. tsx compiles JSX to **classic** runtime (`React.createElement(...)`), which needs `React` in lexical scope.

### Signature of the bug
`pnpm --filter X build` passes, tests throw `React is not defined` inside `react-dom-server-legacy` → `retryNode` → `renderElement` → `renderWithHooks` → your component.

Hit twice this session: `SceneApiContext.tsx` (Phase 2), `hosts/vscode.tsx` (Phase 6b).

### Fix
Any of:
- Add `import * as React from 'react'; void React;` at top of .tsx source.
- Replace JSX with `createElement(...)` calls.
- Configure tsx/TS to use `jsx: "react-jsx"` (matches Vite's automatic runtime) — may not stick depending on tsx's own esbuild defaults.

### Skill
Extracted as user-global skill `tsx-jsx-runtime-mismatch-vite-build-vs-test` (2026-04-17). Subagents generating .tsx files should be pre-emptively warned in their prompts.
