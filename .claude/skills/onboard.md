---
description: "Onboard a project: analyze code, discover features, interview user, write plugins, build knowledge base"
user_invocable: true
---

# /onboard — Learn Your Project Together

Both you (the agent) and the user learn about the project simultaneously.
You bring structural analysis; the user brings domain knowledge.
Together you build a knowledge base, write plugins, and find actionable insights.

## Principles

1. **Don't ask what user wants.** Show the most surprising findings first. User's reaction tells you where to go deeper.
2. **Show before asking.** Lead every question with a graph finding. Include numbers.
3. **Four outputs per answer.** Check: knowledge (KB)? capability (plugin)? guarantee (Datalog rule)? action (task)?
4. **Write immediately.** KB entries, onboarding state — before the next question. Session can die.
5. **Adapt to context.** Solo → skip ownership, focus on debt. Team → full interview. Post-onboard → drift.
6. **"Don't know" = task.** Ask who knows. Create investigation task. Never a dead end.
7. **Never block.** Grafema limitation? Workaround + offer to report. User keeps moving.
8. **Show the delta.** After plugin/re-analysis: "CogLoad 7.1 → 5.3", "38 new edges". Quantify.
9. **Ask before external actions.** Linear issue, GitHub report, push — always ask. Internal writes — just do.

## Flow

### Step 0: Determine state

```
Read .grafema/onboarding-state.yaml (if exists → --continue mode)
Call get_stats:
  nodeCount = 0 → need config phase first
  nodeCount > 0 → graph ready
Check git contributors:
  1 author → solo mode (skip ownership, capabilities, bus factor)
  2+ authors → team mode
```

### Step 1: Show impressive findings immediately

Don't ask abstract questions ("what brought you here?", "what interests you?").
The user doesn't know what's possible yet.

Instead: run discovery queries and show the top 3-5 findings that ONLY the graph
can see. The user's reaction to these findings tells you everything:
- "Whoa, show me more of this" → go deeper on that area
- "That's a known problem" → ask if it should be a guarantee
- "I didn't know that" → you just delivered value, keep going
- "That's wrong" → graph has a gap, investigate/plugin/report

Examples of graph-unique findings (not grep-findable):
- "Longest call chain: 247 hops across 12 files via event bus + HTTP"
- "POST /admin/impersonate has no auth middleware — privilege escalation"
- "getUserById() has 5 side effects despite the name (IO, MUTATION, EVENT)"
- "utils/permissions.ts: 1-line change affects 89% of features (34 callers)"
- "payments↔orders coupling 0.67 — 31 shared functions, 4 shared DB tables"

### Step 2: Run phases

Read `_ai/onboarding/target-state.md` for completion criteria.
Start from the first incomplete phase.
For each phase, read its workflow doc: `_ai/onboarding/phases/0N-*.md`

Phase order:
1. Config (make the graph work)
2. Discovery (auto-find features, components)
3. Validation (user names/corrects findings)
4. Plugins (custom patterns → enrichers)
5. Ownership (who owns what — team mode only)
6. Intent (why is it built this way)
7. Guarantees (codify invariants)
8. Verify (coverage report + next steps)

Skip phases based on context (solo skips 5, curiosity may jump to most interesting).
Max 5–7 questions per session. Say "That's enough for one session" and save state.

### Step 3: Proactive suggestions

Throughout all phases, watch for these triggers:

| You notice | Suggest |
|-----------|---------|
| Unresolved custom pattern (N calls to X) | "Want me to write a plugin for X?" |
| /docs, /adr, README with architecture info | "Can I scan these for KB bootstrap?" |
| CODEOWNERS file | "Import ownership mappings?" |
| OpenAPI/Swagger/GraphQL schema | "Import as endpoint definitions?" |
| .env.example | "Extract service dependencies?" |
| Analysis gap (parser error, missing language) | "Grafema limitation. Workaround + report to devs?" |
| High fan-out event/function | "This looks like a service boundary candidate" |
| Missing auth on entry points | "Security finding: N endpoints without auth guards" |
| User says "I don't know" | "Who would know? Want me to create a task?" |
| User says "ask [person]" | "Creating task for [person]. What should I ask them?" |

### Step 4: Session end

- Update .grafema/onboarding-state.yaml with all progress
- Report: what was learned, what changed (delta), what's next
- Compute OnboardingScore from target-state.md metrics

## Key constraint

**Show what only the graph can see.** If a finding could come from grep or a linter,
it's not impressive. Cross-boundary chains, missing structural patterns, transitive
blast radius, effect propagation through event buses, privilege escalation paths —
these are graph-unique and demonstrate value.
