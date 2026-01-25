# REG-218: Semantic bindings for Node.js built-in modules (fs, http, os, etc.)

## Context

Per REG-206 design decision: built-ins are **Bound**, not Unbound. They're "bindings that ship out of the box."

This applies not just to JS stdlib (`parseInt`, `Array.map`) but also to **Node.js built-in modules**.

## Scope

Create semantic bindings for core Node.js modules:

### Tier 1 — High impact (common in most codebases)

- [ ] `fs` / `fs/promises` — file operations (read, write, stat, etc.)
- [ ] `path` — path manipulation (join, resolve, basename, etc.)
- [ ] `http` / `https` — HTTP client/server operations
- [ ] `crypto` — hashing, encryption operations
- [ ] `child_process` — spawn, exec (security-relevant!)

### Tier 2 — Medium impact

- [ ] `os` — system info queries
- [ ] `url` — URL parsing/formatting
- [ ] `querystring` — query string operations
- [ ] `buffer` — Buffer operations
- [ ] `stream` — stream operations
- [ ] `events` — EventEmitter patterns

### Tier 3 — Lower priority

- [ ] `net` / `tls` — low-level networking
- [ ] `dns` — DNS operations
- [ ] `zlib` — compression
- [ ] `util` — utility functions

## Expected Behavior

```javascript
import { readFile } from 'fs/promises';
import { createServer } from 'http';

const data = await readFile('./config.json');
// → CALLS → BUILTIN_FUNCTION:fs.readFile
// → Data flow: file path → file content

createServer((req, res) => { ... });
// → CALLS → BUILTIN_FUNCTION:http.createServer
// → Creates HTTP_SERVER node with handler reference
```

## Acceptance Criteria

- [ ] Node built-in imports resolved (not CALLS_UNBOUND)
- [ ] Data flow works through pure functions (path.join, etc.)
- [ ] I/O operations create appropriate semantic nodes
- [ ] `child_process.exec` и подобные помечены как security-sensitive

## Related

* REG-206 — External calls policy (parent decision)
* Future: AWS SDK bindings, Express bindings, etc.
