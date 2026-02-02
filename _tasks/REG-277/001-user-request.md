# REG-277: Support re-exported external modules in call resolution

## Background

Currently, if a file re-exports from an external package:

```javascript
// utils.js
export { map } from 'lodash';

// main.js
import { map } from './utils';
map(); // Unresolved
```

The call to `map()` stays unresolved because:

* ExternalCallResolver skips relative imports (`./utils`)
* FunctionCallResolver can't find a FUNCTION node (it's a re-export)

## Solution

Extend FunctionCallResolver to follow EXPORTS_FROM edges and detect when re-export source is external (non-relative), then create CALLS edge to EXTERNAL_MODULE.

## Acceptance Criteria

- [ ] Re-exported external calls create CALLS to EXTERNAL_MODULE
- [ ] Edge metadata includes original exportedName
- [ ] Works for nested re-exports (utils -> helpers -> lodash)

## Context

Discovered during REG-226 implementation. Documented as known limitation in tests.
