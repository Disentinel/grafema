# Phase 2: Discovery — What's in This Codebase?

## Prerequisites
- Phase 1 complete (graph loaded, nodeCount > 0)

## What to do

Fully automated — no user interaction needed. Run queries, present results.

### 2.1 Find entry points

```
find_nodes(type="FUNCTION") with metadata: route, command, eventListener
find_nodes(type="METHOD") called by framework patterns (app.get, router.post, etc.)
```

Framework detection heuristics:
- Express/Koa/Fastify: look for `app.get/post/put/delete` CALL nodes
- React/Vue: default-exported components
- CLI (Commander/Yargs): `.command().action()` chains
- GraphQL: resolver functions
- Message queues: `.process()`, `.on('message')` patterns
- Cron: `schedule()`, `@Scheduled` patterns

### 2.2 Trace feature subgraphs

For each entry point:
```
trace(source=<entry>, along="data", direction="forward", max_depth=15)
```

Collect: nodes, effects (IO/MUTATION), files touched.

### 2.3 Classify files

For each file, compute:
- InternalCoupling = intra-file CALLS edges / (functions × (functions-1))
- EffectDensity = functions with IO/MUTATION / total functions

Library-shaped: InternalCoupling == 0 AND EffectDensity < 0.3
Domain: everything else.

### 2.4 Cluster into components

Compute Jaccard similarity on core (domain-only) feature subgraphs.
Community detection → COMPONENT nodes.
Auto-label from dominant route prefix or directory path.

### 2.5 Detect cross-cutting

Threshold: max(3, |features| × 0.3)
Domain functions appearing in more features than threshold → CROSS_CUTTING.

## Present findings

Show the user a structural summary. This IS the first value delivery:

```
"Your codebase:
 [N] functions, [M] nodes, [K] edges
 Framework: [detected]
 
 [X] features found (API endpoints, handlers, jobs)
 [Y] structural components
 [Z] cross-cutting concerns
 
 Largest component: [name] ([N] features, [M] modules)
 Most connected: [file] (used by [N] features)
 
 Top graph-unique findings:
 • Longest call chain: [N] hops from [A] to [B]
 • [file] has [N] callers across [M] components — riskiest change target
 • [function] named 'get*' but has [N] mutation effects"
```

Focus on **surprising** findings. If nothing is surprising, the project is well-structured — say so.

## Completion
- feature_count > 0
- component_count > 0 (or project is too small for clustering — that's OK)

## Artifacts
- FEATURE nodes in graph (auto-named from routes/commands)
- COMPONENT nodes in graph (auto-named from directories)
- CROSS_CUTTING metadata on relevant functions
