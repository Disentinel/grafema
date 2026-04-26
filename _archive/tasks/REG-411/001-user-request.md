# REG-411: context command: show all methods for classes, not just constructor

## Goal

When `grafema context` is called on a class node, it should show **all methods** of the class, not just the constructor.

## Context

SWE-bench experiment (018) showed that on axios-5085, the agent used `grafema context` on an Axios class and only saw the constructor. It missed 2 of 3 required changes because the other methods weren't shown. The baseline agent, which used raw `cat`, read the full file and found all 3 change points.

This is a direct product gap: Grafema's precision became a liability because it hid relevant context.

## Acceptance Criteria

* `grafema context <class-semantic-id>` returns all methods with their signatures and bodies
* Methods are shown in source order
* Each method includes its edges (CALLS, RETURNS, etc.)

## Evidence

* axios-5085: baseline PASS (found 3/3 changes), grafema FAIL (found 1/3)
* Root cause: `grafema context` showed constructor only, agent didn't explore further
