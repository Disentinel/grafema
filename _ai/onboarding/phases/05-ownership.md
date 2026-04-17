# Phase 5: Ownership — Who Owns What

## Prerequisites
- Phase 3 complete (components named)
- Team mode (skip entirely for solo dev)

## What to do

Map teams to code. Identify bus factor risks.

### 5.1 Auto-detect from available sources

Before asking, extract what's already there:
- **CODEOWNERS** file → parse, import as ownership edges
- **git log** → contributor distribution per component
- **package.json** `author`/`contributors` fields
- **README** team mentions

Present findings:
```
"From git history (last 6 months):
 - payments/: 80% Alice, 15% Bob, 5% others
 - orders/: 60% Charlie, 30% Diana, 10% others
 - auth/: 95% Alice ← bus factor risk
 
 CODEOWNERS says: payments/ → @fintech-team, orders/ → @backend-team
 
 Does this match reality? Any corrections?"
```

### 5.2 Identify bus factor risks

Bus factor = number of people who must disappear before a component becomes unmaintainable.

```
For each component:
  contributors = git log --format='%an' -- [component_path] | sort | uniq -c
  bus_factor = count(contributors with > 10% of commits)
```

Flag: bus_factor == 1 → "Only [person] has touched [component] meaningfully."

### 5.3 Ask about gaps

For components without clear ownership or with conflicts:
```
"Component [X] has 4 contributors but no dominant owner.
 Who's responsible when something breaks here?"
```

| User says | Agent does |
|-----------|-----------|
| Names a person/team | KB: DOMAIN → OWNS → COMPONENT. Update CODEOWNERS if user wants. |
| "It's shared / nobody" | KB: RISK shared_ownership. Flag as organizational debt. |
| "Alice, but she's leaving" | KB: RISK knowledge_transfer_needed. Suggest: create handoff task. |
| "I don't know" | Create task: "Determine ownership of [component]" |

### 5.4 Team boundary vs code boundary check

Compare DOMAIN→OWNS edges with COMPONENT coupling:
```
"payments/ (Fintech team) and orders/ (Backend team) share 31 functions.
 That's cross-team coupling — changes in one require coordination with the other.
 
 Is this a known pain point? Or does coordination work fine?"
```

This surfaces Conway's law mismatches — where team boundaries don't match code boundaries.

## Completion
- > 50% components have ownership assigned
- Bus factor computed for all components
- Bus factor == 1 risks documented

## Artifacts
- DOMAIN → OWNS → COMPONENT edges
- KB: RISK entries for bus factor
- KB: pending tasks for unclear ownership
- Optional: updated CODEOWNERS file
