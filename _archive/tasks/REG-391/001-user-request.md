# REG-391: Multi-root workspace missing strict mode barrier after ENRICHMENT

## Context

Discovered during REG-357 implementation. The `runMultiRoot()` method in `Orchestrator.ts` runs ENRICHMENT but has no strict mode barrier afterward.

## Problem

In `Orchestrator.run()` (single-root path), there is a strict mode barrier after ENRICHMENT (lines 446-455) that collects fatal STRICT_* diagnostics and throws `StrictModeFailure`. This barrier does not exist in `runMultiRoot()`.

When `--strict` is used with multi-root workspaces, strict mode errors during ENRICHMENT are silently ignored. The `hasFatal()` bypass in `runPhase()` (REG-357) lets them through, but nobody checks them in the multi-root path.

## Expected Behavior

Both single-root and multi-root paths should have the same strict mode barrier after ENRICHMENT.

## Solution

Add the same strict mode barrier from `run()` to `runMultiRoot()` after the ENRICHMENT phase (around line 601).

## Effort

~30 minutes
