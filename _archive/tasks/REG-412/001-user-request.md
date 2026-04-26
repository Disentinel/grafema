# REG-412: New command `grafema file <path>` — file-level entity overview

## Goal

Add `grafema file <path>` command that shows all entities in a file with their relationships. A middle ground between `cat` (raw text, no structure) and `grafema context` (single function, too narrow).

## Context

SWE-bench experiment (018) revealed a navigation gap:

* `cat file.js` — shows everything but is expensive (tokens) and unstructured
* `grafema context <id>` — shows one function precisely but misses surrounding context
* **Missing:** a command that shows file structure with relationships

Agents need to understand "what's in this file and how does it connect to the rest of the codebase" — this is the most common exploration pattern observed in the experiments.

## Proposed Output

```
$ grafema file src/core/Axios.js

Module: src/core/Axios.js
Imports: utils, buildURL, InterceptorManager, ...
Exports: Axios (default)

Classes:
  Axios
    constructor(config)     → CALLS: mergeConfig
    request(configOrUrl)    → CALLS: buildURL, dispatchRequest | RETURNS: Promise
    getUri(config)          → CALLS: buildURL | RETURNS: string

Functions:
  forEachMethodNoData(fn)   → internal helper
  forEachMethodWithData(fn) → internal helper

Variables:
  methodsNoData = ['delete', 'get', 'head', 'options']
  methodsWithData = ['post', 'put', 'patch']
```

## Acceptance Criteria

* `grafema file <path>` shows all top-level entities (classes, functions, variables, exports)
* For classes: show all methods with key edges (CALLS, RETURNS)
* For functions: show signature and key edges
* Available in both CLI and MCP
