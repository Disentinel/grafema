# Phase 3: Validation — User Names and Corrects Findings

## Prerequisites
- Phase 2 complete (features and components discovered)

## What to do

Analysis-first elicitation. For each component, show findings and ask.

### Question template

Always lead with a finding. Never ask cold.

```
"Component [auto-name] has [N] features: [route list].
 It shares [M] functions with [other component] (coupling: [score]).
 
 What do you call this area? Is this one capability or multiple?"
```

### Question priority (ask most valuable first)

1. **High-coupling boundaries** — components with Jaccard > 0.3 between them.
   "Are these one thing or two?" reveals architecture.

2. **Surprising findings** — naming incongruence, missing auth, dead code.
   "getUserById has 5 side effects. Intentional?" teaches user about their code.

3. **Ambiguous clusters** — components the algorithm wasn't confident about.
   Low internal cohesion or many features straddling boundary.

4. **Naming** — ask the user's vocabulary, not the graph's.
   Open-ended first: "What do you call this?" 
   Show suggestion only after: "I'd call it 'Payments'. Does that match?"

### Handling responses

| User says | Agent does |
|-----------|-----------|
| Validates name/structure | KB: CAPABILITY node, named. Confirm and move on. |
| Corrects: "actually that's two things" | Split component, re-cluster affected features. |
| Corrects: "those should be together" | Merge components. |
| Provides domain term | KB: ubiquitous language entry. Use this term going forward. |
| "I don't know" | Ask: "Who would know?" → create task. Mark as PENDING in KB. |
| "Ask [person]" | Create Linear task assigned to person. Record in pending_tasks. |
| Shows surprise ("I didn't know that") | Note: this is a cognitive debt signal. Record the gap. |
| Provides rationale ("it's split because...") | KB: DECISION with rationale. This is intent debt reduction. |

### Map to higher entities (team mode only)

After naming components as capabilities, ask:
- "Which product does [capability] belong to?"
- "Who owns [capability]?"
- "How is [capability] deployed? Same process or separate?"

This creates: PRODUCT, DOMAIN (with OWNS edge), DEPLOYMENT_UNIT nodes.

### Session management

- Max 5–7 questions per session
- Write each answer to KB immediately (not batch)
- Update onboarding-state.yaml after each answer
- End with: "That's a good stopping point. [N] features validated, [M] remaining. 
  Run /onboard to continue."

## Completion
- > 60% features have user-validated names
- Key components have capability mapping

## Artifacts
- Named FEATURE nodes
- CAPABILITY nodes (team mode)
- DOMAIN + OWNERSHIP edges (team mode)
- PRODUCT mapping (team mode)
- KB: DECISION nodes from rationale answers
- KB: pending investigation tasks
