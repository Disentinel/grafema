# REG-409: Duplicate edges in context output (8-12 CALLS instead of 4)

## Problem

`grafema context` shows duplicate edges, confusing users and AI agents. For example, `invokeCleanup` in preact shows 8-12 CALLS edges when there are only 4 unique callers.

## Evidence (SWE-bench preact-3345)

Host-built graph: 19421 edges total
Docker-built graph: 12718 edges total (same codebase, same config)

The difference (~6700 extra edges) suggests duplicate edges from parallel analysis or multiple enrichment passes on host.

## Impact

* AI agents see redundant information, wasting context window tokens
* Confusing output for human users ("why does function X have 12 callers when I only see 4 in code?")
* Edge counts unreliable as a quality metric

## Acceptance Criteria

- [ ] `grafema context` shows unique edges only (deduplicated by source+target+type)
- [ ] Investigate root cause: parallel analysis vs enrichment duplication
- [ ] Edge counts consistent between host and Docker builds of same project
- [ ] Add deduplication test
