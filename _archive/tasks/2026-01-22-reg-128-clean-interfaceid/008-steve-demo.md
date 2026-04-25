# Steve Jobs Demo Report: REG-125, REG-126, REG-128

## Demo Session: January 22, 2026

## Executive Summary

**Verdict: NOT READY FOR STAGE**

The vision is right. Semantic IDs are the future. But execution is incomplete. I am seeing inconsistency that would embarrass us on stage.

---

## What I Tested

Created a simple JavaScript project with:
- A top-level function `processUser`
- A class `UserService` with method `getUser`
- A variable `name` with data flow

Ran `grafema analyze`, then tested query, trace, and impact commands.

---

## The Good

### 1. REG-125: Semantic IDs in CLI Output - WORKS

Top-level functions show beautiful semantic IDs:

```
$ grafema query "processUser"

[FUNCTION] processUser
  ID: index.js->global->FUNCTION->processUser
  Location: index.js:1
```

**This is exactly what I asked for.** The ID tells you everything:
- File: `index.js`
- Scope: `global`
- Type: `FUNCTION`
- Name: `processUser`

Clean. Readable. No cryptic hashes.

### 2. REG-126: MODULE Nodes - WORKS

```json
{
  "id": "index.js->global->MODULE->module",
  "name": "index.js"
}
```

Gone are the hash-based `MODULE:d35ecb7a760522e501e4ac32019175bf...` IDs. This is progress.

### 3. REG-128: Dead Code Cleanup - VERIFIED

The TypeScriptVisitor no longer computes useless IDs. Internal cleanup. Users won't see it, but the codebase is cleaner.

### 4. Data Flow Tracing

```
$ grafema trace "name"

[VARIABLE] name
  ID: index.js->processUser->VARIABLE->name
  Location: index.js:2

Data sources (where value comes from):
  <- user.name (EXPRESSION)
```

The semantic ID correctly shows the scope chain: `index.js->processUser->VARIABLE->name`. This is how code navigation should work.

---

## The Bad

### Class Methods Still Have Legacy IDs

This is the killer:

```
$ grafema query "User"

[FUNCTION] processUser
  ID: index.js->global->FUNCTION->processUser     <-- CLEAN
  Location: index.js:1

[FUNCTION] getUser
  ID: FUNCTION#UserService.getUser#/private/tmp/steve-demo/index.js#8:2     <-- UGLY
  Location: index.js:8

[CLASS] UserService
  ID: index.js->global->CLASS->UserService        <-- CLEAN
  Location: index.js:7
```

**Why does `getUser` have a legacy hash ID while everything else has semantic IDs?**

Expected:
```
ID: index.js->UserService->FUNCTION->getUser
```

Got:
```
ID: FUNCTION#UserService.getUser#/private/tmp/steve-demo/index.js#8:2
```

This inconsistency is jarring. It screams "unfinished work."

### EXPRESSION IDs Still Use Legacy Format

In the trace output:
```
Data sources (where value comes from):
  <- user.name (EXPRESSION)
     /private/tmp/steve-demo/index.js:EXPRESSION:MemberExpression:2:44
```

That EXPRESSION ID is using colon-separated format, not the arrow-based semantic ID format.

---

## The Assessment

| Feature | Status | Would I Show on Stage? |
|---------|--------|----------------------|
| REG-125: CLI semantic IDs | Partial | No - inconsistent for methods |
| REG-126: MODULE semantic IDs | Done | Yes |
| REG-128: Dead code cleanup | Done | N/A (internal) |

---

## What Needs to Happen

### Must Fix Before Demo

1. **Class method IDs must use semantic format**
   - `UserService.getUser` should be `index.js->UserService->FUNCTION->getUser`
   - Not `FUNCTION#UserService.getUser#...`

### Nice to Have

2. **EXPRESSION nodes should use consistent format**
   - Currently: `/path:EXPRESSION:MemberExpression:2:44`
   - Better: `index.js->processUser->EXPRESSION->user.name` (or similar)

---

## The Elephant in the Room

We have a semantic ID system designed for humans and AI agents. But we're only using it for *some* node types. The migration is incomplete.

Looking at the codebase, I see `FUNCTION#` patterns in:
- `AnalysisWorker.ts`
- `QueueWorker.ts`
- `ASTWorker.ts`
- `ClassVisitor.ts` (line 246, 307)
- `JSASTAnalyzer.ts`
- And more...

This is a systemic issue. The semantic ID migration touched some code paths but not others.

---

## Final Verdict

**Do NOT demo this to users.**

The inconsistency undermines the entire value proposition. When a user queries their code and sees two different ID formats in the same result set, they lose confidence. "Is this product finished? Do the developers know what they're doing?"

The work done is good work. REG-125 and REG-126 made real progress. But we shipped an inconsistent experience.

---

## Recommendation

Create a new issue: **Complete Semantic ID Migration for All Node Types**

Scope:
1. Class methods (ClassVisitor.ts)
2. Arrow functions in assignments
3. Anonymous functions
4. EXPRESSION nodes (or document why they're different)

Until then, this feature is not ready for the stage.

---

*"Real artists ship. But they don't ship half-finished products."*

-- Steve Jobs, Demo Report
