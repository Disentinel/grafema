# REG-273: Flag side-effect-only imports

## Request

Side-effect-only imports need to be distinguished from regular imports:
```javascript
import './polyfill.js';      // Side-effect only - no bindings
import { foo } from './lib'; // Regular import with bindings
```

We need to add a `sideEffect: boolean` flag to IMPORT nodes.

## Context

This is a Mini-MLA task with clear scope and local changes. Need to:
1. Add flag to distinguish side-effect imports
2. Update import handling logic
3. Ensure dead code analysis excludes side-effect imports

## Goal

Add `sideEffect: boolean` attribute to IMPORT nodes to properly distinguish imports that only execute module code vs imports that bind values.
