# REG-347: CLI: Add loading indicator for slow queries on large graphs

## Problem

On large graphs (1.5M+ nodes), queries are no longer instant. User has no feedback that query is running.

## Request

Add loading/spinner indicator while query is executing.

## Affected commands

* `grafema query`
* `grafema ls`
* `grafema get`
* Any command that queries the graph

## Implementation

Use ink spinner or simple "Loading..." message while waiting for RFDB response.
