# Autonomous R&D Workflow

Continuous self-improving loop that finds gaps in Grafema's language coverage and generates validated fixes — autonomously, with human review only at release time.

## Core Idea

Grafema's thesis is that the graph should be the superior way for AI agents to understand code. The only way to know if it actually is — on real code, for real tasks — is to measure it empirically and continuously.

The loop: take real bugs from real open-source projects, try to solve them with and without Grafema, observe where the graph fails to help, generate hypotheses, test them, ship confirmed improvements.

## Scientific Method Applied

```
GitHub closed issue (ground truth fix is known)
            ↓
    ┌────────┴────────┐
    A: agent          B: agent
  without           with
  Grafema           Grafema MCP
    └────────┬────────┘
             ↓
      Compare both solutions
      to ground truth fix
             ↓
      B better?         A equal or better?
         ↓                      ↓
   Grafema helps.       Generate hypotheses
   Add to validated     (agent sees: what it
   corpus.              queried, what returned,
                        what was empty)
                               ↓
                   Hypothesis 1: MCP prompt/docs
                   Hypothesis 2: new graph construct
                   Hypothesis 3: not graph-solvable
                               ↓
                       Test hypothesis
                               ↓
                   Confirmed → staging queue
                   Rejected  → discard
```

Human reviews only the staging queue — a batch of confirmed improvements — before each release.

## Why Weak Models Are Useful for Signal

A strong model may solve the bug even without the graph (by reading files). A weak model can't brute-force it, so the signal from Grafema is stronger. POC should start with local small models — if the architecture works there, it definitely works with Claude.

## Filtering: Graph-Solvable vs Not

The classifier runs on the **diff of the fix**, not the issue text.

**Graph-solvable** (structural changes):
- Call site with wrong arguments → data flow shows where value came from
- Unexpected mutation → mutation tracking
- Wrong import / circular dependency → dependency graph
- Dead code, wrong callback order → reachability

**Not graph-solvable** (runtime/domain):
- Memory leaks, race conditions → need runtime profiler
- Algorithm logic errors → need domain understanding
- UI/CSS bugs, performance → need browser/profiler

## Hypothesis Priority: Cheap First

When B loses to A, try fixes in ascending cost order:

1. **Rewrite MCP tool description** — minutes, test immediately
2. **Add usage example to MCP prompt** — minutes
3. **Add Datalog rule** — hours
4. **New enricher in core** — days

Many gaps are not missing graph constructions — they're the agent not knowing which MCP query to use.

## Evidence-Based Hypothesis Generation

When B underperforms, the agent has full evidence:
- Every MCP call it made (`queryNodes`, `queryEdges`, ...)
- What the graph returned (including empty results)
- The ground truth fix: what structurally changed

This produces specific, falsifiable hypotheses:
> "I queried call sites of `fn?.()` and got 0 results. The fix required knowing that `handleUpdate` calls `persist`. Hypothesis: optional chaining calls are not indexed."

Not guessing. Evidence from the actual run.

## Validated Corpus as Regression Suite

Every confirmed improvement becomes a test case. As the corpus grows, it becomes a regression suite specific to Grafema: run it before each release to verify nothing that previously worked has broken.

Unlike static SWE-bench, this corpus is:
- Infinite (GitHub has millions of closed issues)
- Self-weighted toward real language patterns in real codebases
- Product-aligned: every test literally asks "does Grafema help an agent here?"

## Infrastructure

### POC: Local Mac

```
Ollama (Qwen3-8B/14B)
+ Grafema MCP (already exists)
+ Node.js orchestrator (~200 lines)
+ GitHub API for issue fetching
+ SQLite for results
```

Agent loop: OpenHands supports Ollama + MCP out of the box — fastest path to POC without building a custom agent loop.

### Production: Small VPS + Claude API

```
Hetzner/DigitalOcean VPS ($10-20/mo)  ← orchestrator, scheduler, SQLite
Claude API (pay-per-use)               ← agents A and B
Grafema indexer (same VPS)             ← runs on new repos as needed
```

No GPU required. Most cost is in API calls, not server.

**Cost estimate with prompt caching:**

| Item | Cost |
|------|------|
| One A/B experiment (2 Sonnet agents, cached codebase) | ~$0.30–0.80 |
| Hypothesis generation (Haiku) | ~$0.05 |
| Hypothesis test | ~$0.30–0.50 |
| **Per bug total** | **~$0.50–1.50** |

At 10 experiments/day: ~$150–450/month. Human reviews confirmed improvements once per sprint.

## Human Role

Pull model, not push. You don't react to individual results.

```
24/7 autonomous:
  Crawler → issue queue
  → A/B experiment
  → if B loses: hypothesis → test
  → confirmed improvement → staging queue

Human (you):
  → weekly/sprint: review staging queue
  → approve batch → release
```

## POC Validation Steps

1. Pick one closed issue from a JS/TS repo manually (with PR = ground truth)
2. Run agent A: Ollama, no MCP, "here's the repo and bug, fix it"
3. Run agent B: Ollama + Grafema MCP, same prompt
4. Compare both solutions to real fix (visual inspection is fine for POC)
5. Log: what did B query, what did it get back, where was the graph empty

If there's a visible difference on one bug — architecture is validated.

## Prior Art

All component ideas have been explored in research — but not in this specific combination.

### What exists

**[LIVE-SWE-AGENT](https://arxiv.org/abs/2511.13646)** (Nov 2025) — closest in spirit. Agent synthesizes and modifies its own tools at runtime while solving issues: notices a missing tool, writes it, uses it. Achieves 77.4% on SWE-bench Verified without test-time scaling. Key difference: the agent improves *itself*, not an external tool.

**[SWE-rebench](https://arxiv.org/abs/2505.20411)** — automated pipeline that continuously extracts real-world tasks from GitHub repos (21k+ tasks for RL training). Exactly the "closed issues as infinite corpus" idea, ready to use.

**[R2E-Gym](https://github.com/R2E-Gym/R2E-Gym)** (COLM 2025) — turns any GitHub repo into a benchmark environment with executable tests. The "verify against open-source codebases" infrastructure, already built.

**[SWE-Search](https://proceedings.iclr.cc/paper_files/paper/2025/file/a1e6783e4d739196cad3336f12d402bf-Paper-Conference.pdf)** (ICLR 2025) — MCTS over code edits with a value function that identifies coverage gaps. Similar to the hypothesis-driven search idea.

### What nobody has done

All of the above improve the **agent** or the **benchmark**. None of them do:

> An A/B loop where the variable is an external **graph tool** (Grafema), not the agent itself. When the agent with the tool loses — the tool improves, not the agent.

This is the inverse of LIVE-SWE-AGENT: not "agent learns to build better tools for itself" but "external tool becomes better by measuring its own usefulness to agents."

The closest analogy in ML is improving a **retrieval system** via downstream task signal — but for a code graph, this hasn't been done.

### What to reuse for POC

- **SWE-rebench** as crawler — already extracts issues with ground truth from GitHub
- **R2E** for spinning up execution environments per repo
- **mini-SWE-agent** (LIVE-SWE-AGENT's base) as a lightweight agent for A/B runs

The POC can be assembled from existing components rather than built from scratch.

## Open Questions

- How fast is a full test suite run on target repos? (determines iterations/hour)
- Does Grafema currently report unresolved nodes (AST nodes it couldn't classify)? This would be the most direct gap signal.
- Which open-source repos to start with? Good candidates: medium-sized JS/TS projects with active issue trackers (e.g., express, chalk, date-fns, zod).
