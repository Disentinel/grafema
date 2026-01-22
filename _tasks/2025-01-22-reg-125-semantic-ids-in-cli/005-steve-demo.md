# Demo Report: REG-125 Semantic IDs in CLI Output

**Reporter:** Steve Jobs
**Date:** 2025-01-22
**Status:** APPROVED with notes

---

## The Demo

I ran Grafema on a simple test project with three functions: `authenticate`, `validate`, and `login`.

### Query Command

```bash
$ grafema query authenticate -p /tmp/grafema-semantic-test

[FUNCTION] authenticate
  ID: index.js->global->FUNCTION->authenticate
  Location: index.js:1

Called by (1):
  <- index.js->global->FUNCTION->login
```

### Impact Command

```bash
$ grafema impact authenticate -p /tmp/grafema-semantic-test

[FUNCTION] authenticate
  ID: index.js->global->FUNCTION->authenticate
  Location: index.js:1

Direct impact:
  1 direct callers
  0 transitive callers
  1 total affected

Direct callers:
  <- index.js->global->FUNCTION->login

Call chains (sample):
  authenticate -> login

Risk level: LOW
```

---

## Evaluation

### 1. Is the semantic ID prominently displayed as the PRIMARY identifier?

**YES.** The semantic ID is now shown right there, second line, labeled clearly as "ID". No need to pass `--json` or dig through debug output. This is exactly what we needed.

The format `index.js->global->FUNCTION->authenticate` is human-readable - you can SEE the path: file, scope, type, name. It reads like a sentence.

### 2. Is the output format clean and human-readable?

**YES.** The hierarchy is clear:
- Type badge in brackets: `[FUNCTION]`
- Name immediately after
- ID on its own line with clear label
- Location on its own line
- Relationships shown with arrows

This is scannable. A user can glance at it and know what they're looking at.

### 3. Can users easily copy-paste semantic IDs for further queries?

**PARTIAL.** The ID is on its own line, which makes it easy to select and copy. That's good.

However, I tested the copy-paste workflow:

```bash
$ grafema query "index.js->global->FUNCTION->authenticate"
No results for "index.js->global->FUNCTION->authenticate"
```

This does NOT work. The query command doesn't recognize semantic IDs as input patterns. This is a friction point in the workflow - users can see the ID but can't use it directly.

**Note:** This is a separate issue from REG-125. The task was to SHOW semantic IDs, not to accept them as query input. But it's worth noting for a follow-up task.

### 4. Does this solve the original complaint?

The original complaint was: *"This is like hiding the product behind a debug flag"*

**YES, this is solved.** Before this change, you had to use `--json` to see what's in the graph. Now the semantic identity is front and center. The graph is no longer hidden.

---

## What I Love

1. **The arrow notation** - `index.js->global->FUNCTION->authenticate` tells a story. It's not a hash. It's not an internal ID. It's the semantic path through the code.

2. **Consistency** - Both `query` and `impact` show the same format. The callers also show their semantic IDs.

3. **Clean hierarchy** - Type, then ID, then location. Information architecture is correct.

---

## What Needs Improvement (Future Work)

1. **Query by semantic ID** - Users should be able to copy an ID and paste it as a query. Right now they can't. This should be a follow-up task.

2. **Server noise** - The `[RFDBServerBackend]` and `[rfdb-server]` lines are noise in the output. For a demo this is distracting, though I understand it might be useful for debugging. Consider suppressing by default.

---

## Verdict

**APPROVED**

The feature does what it set out to do: semantic IDs are now visible in default CLI output. Users no longer need to pass `--json` to understand what's in their graph. The output is clean and professional.

Would I show this on stage? **Yes.** It's not perfect - I'd want the server noise suppressed and the query-by-ID workflow to work. But those are polish items for the next release.

Ship it.

---

*"People don't know what they want until you show it to them."*
This feature shows users what they have. That's the foundation of everything else.
