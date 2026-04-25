# Steve Jobs Demo Report: REG-172

## Demo Session

### The Setup

Created a realistic TypeScript backend project:

```
/tmp/demo-ts-project/
├── package.json       (main: "dist/index.js")
├── tsconfig.json      (outDir: "dist")
├── src/
│   └── index.ts       (Express app with /api/users endpoint)
└── dist/
    └── index.js       (compiled stub - what we DON'T want)
```

This is the exact scenario users hit: `package.json` points to compiled output, but the code they want analyzed is in `src/`.

---

### The Test

```bash
$ grafema analyze /tmp/demo-ts-project --verbose
```

**Key line from output:**
```
[DEBUG] Processing file {"file":"/src/index.ts","depth":0}
```

**BOOM.** TypeScript source is being processed, not `dist/index.js`.

---

### Verification

Queried the graph:

```bash
$ grafema query -p /tmp/demo-ts-project "index"

[MODULE] src/index.ts
  ID: src/index.ts->global->MODULE->module
  Location: src/index.ts
```

And with JSON output:

```json
{
  "id": "index.ts->global->VARIABLE->app",
  "type": "VARIABLE",
  "name": "app",
  "file": "/tmp/demo-ts-project/src/index.ts",
  "line": 3
}
```

The file path is `src/index.ts`, not `dist/index.js`. This is correct.

---

### Negative Test

Also verified plain JavaScript projects still work:

```bash
$ grafema analyze /tmp/demo-js-project --verbose
[DEBUG] Processing file {"file":"/index.js","depth":0}
```

For a project with no TypeScript, it correctly falls back to `main` field in package.json.

---

## Would I Show This On Stage?

**Yes.**

Here's why:

1. **It works.** The core fix is solid - TypeScript projects are indexed from source.

2. **It's invisible.** Users don't need to configure anything. `grafema analyze` just does the right thing. The best features are the ones users never notice because they "just work."

3. **It doesn't break anything.** Plain JS projects still work as before.

4. **The demo is clean:**
   - Run analyze
   - See source file in logs
   - Query graph, get source locations
   - Done

---

## What Could Be Better

Minor polish items (not blockers):

1. **Verbose output could be clearer.** The log says:
   ```
   [DEBUG] Processing file {"file":"/src/index.ts","depth":0}
   ```
   For a demo, it would be nice to see something like:
   ```
   [INFO] TypeScript project detected, using src/index.ts as entrypoint
   ```
   Users would understand immediately what happened. (Low priority - this is developer debugging output.)

2. **Query results could show more metadata.** When I query for "users" (the API endpoint), I get no results. The Express route analyzer found the endpoint (`endpointsCreated":1`), but it's not easily queryable by name. This is a separate feature request, not part of this fix.

---

## Verdict

**Ship it.**

The fix addresses a critical blocker for TypeScript onboarding. It's simple, correct, and maintains backward compatibility. The implementation is clean - just detect TypeScript and prefer source over compiled output.

This is exactly what I'd show a user who says "I have a TypeScript project, will Grafema work?" Yes. Yes it will.

---

*"Simple can be harder than complex. You have to work hard to get your thinking clean to make it simple. But it's worth it in the end because once you get there, you can move mountains."*
