# REG-120: net:request and net:stdio singleton nodes not created

## Source

Discovered during REG-118 fix. Tests for singleton survival fail because singletons aren't created.

## Problem

Network singleton nodes (`net:request`, `net:stdio`) are expected to be created when code uses `console.log` or `fetch`, but they're not being created.

## Expected Behavior

* `console.log()` → creates `net:stdio` singleton node
* `fetch()` → creates `net:request` singleton node

## Actual Behavior

0 singleton nodes created. The GraphBuilder has `_createdSingletons` tracking but singletons aren't being generated.

## Investigation Needed

* Check `createSingletonNode` logic in GraphBuilder
* Verify when/how singletons should be created
