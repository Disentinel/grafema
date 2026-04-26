# REG-125: UX - Show semantic IDs in default CLI output

## Summary

From Steve Jobs' demo feedback on REG-123: Semantic IDs are hidden behind `--json` flag. Users should see the semantic ID as the primary identifier without needing special flags.

## Current Behavior

Default output shows line numbers but not semantic IDs. Users must add `--json` flag to see semantic IDs.

## Expected Behavior

Semantic IDs should be visible in default output format, with line numbers as secondary information.

## Context

> "This is like hiding the product behind a debug flag."
>
> * Steve Jobs, REG-123 Demo Report

## Related

* REG-123 (Semantic IDs implementation - complete)
