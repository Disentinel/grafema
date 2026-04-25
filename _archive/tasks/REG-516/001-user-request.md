# User Request: REG-516

**Source:** Linear issue REG-516
**Date:** 2026-02-19

## VSCode Phase 4: BLAST RADIUS Panel

### Goal

Unique feature — show impact of changing a function/variable: what breaks, how far the damage spreads.

### Scope

#### BLAST RADIUS Panel (TreeView)

* Select function/variable → see everything that depends on it
* BFS over incoming edges (who depends on me, recursively)
* Grouped:
  * **Direct dependents** — one hop away (● filled circle icon)
  * **Indirect dependents** — 2+ hops (○ hollow circle icon), with "via X" description
  * **Guarantees at risk** — which guarantees reference this node (⚠ warning icon)
* Summary at bottom: "8 total dependents · 5 files · 1 guarantee"
* Impact score: LOW/MEDIUM/HIGH based on dependent count + guarantee count

#### Scoring

* Direct callers × 3 + indirect × 1 + guarantees × 10
* LOW: 0-10, MEDIUM: 11-30, HIGH: 31+
* Show as colored icon in tree root

### Dependencies

* reachability() or BFS in RFDB client
* Guarantee engine for "guarantees at risk"

### Acceptance Criteria

- [ ] Panel shows direct/indirect dependents grouped
- [ ] "via X" shows dependency chain for indirect
- [ ] Guarantees at risk listed
- [ ] Impact score calculated and shown
- [ ] Click any node → jump to source
