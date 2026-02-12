# Architecture Planning Workflow

Multi-track design process for major system changes that span multiple components.

## When to Use

- Major architecture change affecting 2+ subsystems (storage + orchestrator + client)
- Expert reviews surface cross-cutting concerns that can't be resolved in one component
- Need to coordinate parallel design tracks with shared contracts
- Roadmap for a core system rewrite (database engine, protocol, pipeline)

## The Problem

Single-track roadmaps for deep system changes create blind spots. RFDB v2 roadmap (Rust storage engine) had 17 expert concerns, but 4 of them (C1, C2, I5, Q3) were orchestrator concerns that couldn't be resolved without designing the orchestrator v2 in parallel.

## Workflow

### Phase 1: Architecture Research + Roadmap

1. Write architecture research doc (prior art, tradeoffs, decisions)
   - **Expert must WebSearch** for existing approaches before proposing solutions
2. Write development roadmap with phased delivery
   - Joel Spolsky expands into detailed tech plan with Big-O analysis
3. Save to `_tasks/{feature-name}/002-roadmap.md`

### Phase 1.5: MLA Expert Review

Run **domain-specific expert reviews** as parallel subagents, each with a different lens:

| Expert | Lens | What they catch |
|--------|------|----------------|
| **Robert Tarjan** (Graph Theory) | Algorithms, traversal, complexity | O(n) scans, missing indexes, cycle issues |
| **Patrick Cousot** (Static Analysis) | Soundness, completeness, fixpoints | Missed deltas, unsound incremental updates, ordering bugs |
| **Anders Hejlsberg** (Type Systems) | Practical engineering, API design | Fragile IDs, missing streaming, underestimated scope |
| **Steve Jobs** (Product/Vision) | Does it serve the user? Is it right? | Hacks, MVP limitations that defeat purpose, scope gaps |

**Execution:**
- Each expert runs as a separate subagent (can be parallel — they read the same docs independently)
- Each writes `003-{expert}-review.md` with findings categorized by severity
- Reviews should be thorough — experts are encouraged to challenge the design

**Consolidation:**
- After all reviews complete, merge into `004-expert-concerns.md`
- Deduplicate overlapping concerns, note which experts flagged each
- Categorize: Critical / Important / Nice-to-have / Questions
- Each concern gets a `Decision: [ ]` field for tracking

**Key insight:** Different experts catch different things. Tarjan catches algorithmic flaws. Cousot catches soundness gaps. Hejlsberg catches API design issues. Steve catches vision misalignment. Running all four in parallel maximizes coverage without serial bottleneck.

**When to skip experts:**
- Trivial changes (single module, <100 LOC) — no MLA needed
- Well-understood tasks with clear requirements — Mini-MLA (Don + Steve)
- Only use full expert panel for architectural decisions with long-term impact

### Phase 2: Identify Parallel Tracks

Read consolidated concerns and classify each by **owning component**:

```
Concern → Which component must change to resolve it?
  C1: guarantee delta    → Orchestrator (not RFDB)
  C2: ordering invariant → Orchestrator (not RFDB)
  I2: edge ownership     → RFDB (storage layer)
  I5: enricher ordering  → Orchestrator (not RFDB)
```

If >25% of concerns belong to a different component than the roadmap → **parallel track needed**.

### Phase 3: Parallel Research

Launch exploration agents in parallel to map current architecture:

```
Agent 1: Current orchestrator pipeline (phases, lifecycle, data flow)
Agent 2: Current client/protocol (wire format, ID handling, batching)
Agent 3: Current enrichment pipeline (enrichers, dependencies, execution model)
```

Key: agents run concurrently. Each explores one subsystem independently. Results synthesized after all complete.

### Phase 4: Define Tracks + Contract

Create separate design docs per track:

| Track | Scope | Contract with other tracks |
|-------|-------|---------------------------|
| Track 1: Storage Engine | Rust internals, segment format, queries | Provides: batch commit, delta, snapshots |
| Track 2: Orchestrator | Pipeline lifecycle, enrichment, guarantees | Consumes: delta from CommitBatch, snapshot isolation |
| Track 3: Client/Protocol | Wire format, streaming, ID handling | Bridge between Track 1 and Track 2 |

**Contract document** is the critical artifact: what each track provides and consumes. Without it, tracks diverge.

### Phase 5: Resolve Concerns Against Tracks

Go through concerns one by one. For each:
1. Which track owns the resolution?
2. Does it affect the contract?
3. Decision + rationale → log in concerns doc

```markdown
| # | Concern | Decision | Track | Date |
|---|---------|----------|-------|------|
| C1 | Post-enrichment delta | Union of CommitBatch deltas | Track 2 | ... |
| C2 | Ordering invariant | Epoch-based, orchestrator enforces | Track 2 | ... |
```

## Key Principles

1. **Concerns reveal missing tracks.** If expert reviews keep pointing to a component you didn't plan to redesign, you need a parallel track for it.

2. **Research before design.** Explore the current codebase before writing design docs. Agents can map architecture faster than reading code manually.

3. **Contract-first.** Define what each track provides/consumes before writing detailed designs. Prevents design-time integration surprises.

4. **Resolve concerns against tracks, not in isolation.** Each concern belongs to exactly one track. Cross-track concerns go into the contract.

5. **Phase independence.** Early phases of one track shouldn't depend on other tracks. Track 1 phases 0-4 can proceed while Track 2 is still in design.

## Anti-patterns

- **Single-track tunnel vision**: roadmap covers only the storage engine, but concerns keep pointing to orchestrator. "Out of scope" is not a resolution.
- **Designing the contract last**: building Track 1 API surface without knowing what Track 2 needs. Results in API rework.
- **Sequential tracks**: waiting for Track 1 to complete before starting Track 2 design. Phases 0-4 of Track 1 don't need Track 2, but Phase 5+ does. Start Track 2 design in parallel with Track 1 Phase 0.

## File Organization

```
_tasks/{feature-name}/
  001-user-request.md
  002-roadmap.md               # Track 1 (primary)
  003-{expert}-review.md       # One per expert
  004-expert-concerns.md       # Consolidated
  005-orchestrator-design.md   # Track 2
  006-client-spec.md           # Track 3
  007-contract.md              # Cross-track contract
```
