# Steve Jobs Release Assessment: Grafema v0.2

*Date: 2026-02-04*

---

## The Demo

I just saw it work. On Jammers — a real project, not a contrived test case.

Click on a `fetch('/api/invitations')` call in the frontend. Grafema traces it to the backend handler. Click on `res.json(invitations)` in that handler, and you can trace back to where that data came from — a SQLite query.

**Frontend to backend. Code to data. In clicks.**

That's not a demo. That's the product.

---

## What We Promised

From the README and ROADMAP, here's what we claimed for v0.1/v0.2:

### Core Infrastructure (v0.1) - DELIVERED

| Capability | Status | Reality Check |
|-----------|--------|---------------|
| Graph-based code representation | **WORKS** | RFDB + Datalog engine is solid |
| Data flow and alias tracking | **WORKS** | REG-334 fixed Promise tracking |
| Datalog query support | **WORKS** | `attr()`, `edge()`, `attr_edge()` all functional |
| MCP integration | **WORKS** | Claude Code uses it to query the graph |
| Plugin architecture | **WORKS** | 20+ plugins, extensible by phase |

### Data Flow Features (v0.2) - DELIVERED

| Feature | Status | What Changed |
|---------|--------|--------------|
| Cross-service tracing (REG-252) | **DONE** | Frontend-to-backend works |
| Promise dataflow (REG-334) | **DONE** | `resolve()` calls tracked |
| Router mount prefixes (REG-248) | **DONE** | `/api` prefixes resolved |
| Wrapper function support (REG-333) | **DONE** | `asyncHandler` pattern works |
| Column-precise locations (REG-337/339) | **DONE** | VS Code can select exact nodes |

### VS Code Extension - BONUS DELIVERY

Not explicitly promised in ROADMAP, but it exists and works:
- Cmd+Shift+G finds node at cursor
- Expand edges, trace connections
- Click to navigate source

---

## What's Still Missing

### The Honest Truth

1. **npm publishing is incomplete** - packages exist but aren't properly versioned/published
2. **CLI `grafema` command** - documentation shows it, but actual binary setup isn't documented
3. **Changelog is stale** - shows [0.1.1-alpha] from 2025-01-25, we've shipped dozens of features since
4. **README is too modest** - claims "early alpha, not for production use" when the happy path WORKS

### From ROADMAP v0.2 Still Open

| Issue | Status | Impact |
|-------|--------|--------|
| REG-314 (Cardinality tracking) | In Progress | Nice-to-have, not blocking |
| REG-256 (Config-based routing rules) | Backlog | Edge case for complex proxies |
| REG-310 (Server-side scope filtering) | Backlog | Performance optimization |
| REG-306 (JSASTAnalyzer tech debt) | Backlog | Internal quality, not user-facing |

None of these are blockers for demonstrating value.

---

## Release Readiness Verdict

### Is it ready for a public release?

**YES, with conditions.**

The core value proposition works:
- AI queries the graph instead of reading code
- Frontend-to-backend tracing is real
- VS Code extension provides visual exploration

But we can't just push to npm and call it a day.

### Conditions for Release

1. **Version bump** - Call it `0.2.0-beta` (not alpha — alpha implies barely functional)

2. **Changelog must be updated** - Document everything from REG-225 through REG-339

3. **README must reflect reality** - Remove the "not recommended for production" warning from top. Replace with honest capability description.

4. **Installation must be documented** - Clear steps for:
   - MCP setup (already good)
   - VS Code extension install
   - CLI setup (needs work)

5. **Demo video** - 60 seconds showing the Jammers workflow. Worth 1000 words of docs.

---

## Documentation Requirements

### Must Update

| Document | What Needs Changing |
|----------|---------------------|
| `README.md` | Remove alpha warning, add VS Code extension, show real capabilities |
| `CHANGELOG.md` | Add all REG-* features since 0.1.1-alpha |
| `packages/vscode/README.md` | Add "how to install from VSIX" |

### Must Create

| Document | Purpose |
|----------|---------|
| `docs/getting-started.md` | 5-minute quickstart: init, analyze, query |
| `docs/cross-service-tracing.md` | The killer feature — document it properly |

### Already Good

| Document | Status |
|----------|--------|
| `docs/configuration.md` | Excellent — complete and accurate |
| `docs/project-onboarding.md` | Good — comprehensive workflow |
| `docs/datalog-reference.md` | Good — but needs attr_edge() addition |

---

## Changelog Draft

Here's what should be in CHANGELOG.md for v0.2.0:

```markdown
## [0.2.0-beta] - 2026-02-04

### Highlights

- **Cross-service tracing** - Click on a frontend fetch call, trace to backend handler
- **VS Code Extension** - Interactive graph navigation (Cmd+Shift+G)
- **Promise dataflow** - Track data through resolve() callbacks
- **Column-precise locations** - All nodes have exact column positions

### Data Flow

- REG-252: Cross-service value tracing (frontend <-> backend)
- REG-334: Promise dataflow tracking through resolve() calls
- REG-333: Support wrapper functions (asyncHandler, catchAsync)
- REG-263: Track return statements (RETURNS edge)
- REG-229: Argument-to-parameter binding
- REG-225: Cross-file imported function call resolution
- REG-232: Re-export chain resolution

### Control Flow

- REG-267: Control flow layer (BRANCH, LOOP, TRY_BLOCK nodes)
- REG-272: Loop variable declarations (for...of/for...in)
- REG-268: Dynamic imports with isDynamic flag
- REG-274: IfStatement tracking
- REG-275: SwitchStatement tracking

### Graph Improvements

- REG-337/339: Column location for all physical nodes
- REG-313: Nested paths in attr() predicate
- REG-315: attr_edge() predicate for edge metadata
- REG-250: Fixed attr() to return attribute values
- REG-251: Fixed edge() predicate

### Enrichment

- REG-248: Router mount prefix resolution
- REG-226: External package call resolution
- REG-309: Scope-aware variable lookup
- REG-269: Transitive closure captures
- REG-262: Method call usage edges

### Query UX

- REG-307: Natural language query support
- REG-253: Query by arbitrary node type
- REG-249: http:request nodes searchable

### Validation

- REG-261: Broken import detection
- REG-227: Updated CallResolverValidator

### Bug Fixes

- REG-322: HANDLED_BY edge finds correct handler
- REG-321: MAKES_REQUEST links to CALL node
- REG-318: MountPointResolver module matching
- REG-308: Server-side file filtering
- REG-247: WorkspaceDiscovery entrypoint passing
```

---

## Concerns

### One Real Blocker

**The CLI is phantom.** Documentation shows `grafema analyze`, `grafema query`, etc., but there's no clear path to install the `grafema` command globally.

Looking at the packages:
- `@grafema/cli` exists but isn't in the README's npm install instructions
- The README shows `npx @grafema/mcp` but not how to get the CLI

**Fix:** Add to README:
```bash
npm install -g @grafema/cli
# Now you can run:
grafema init
grafema analyze
grafema query "pattern"
```

Or if we're npx-only:
```bash
npx @grafema/cli init
npx @grafema/cli analyze
npx @grafema/cli query "pattern"
```

Pick one. Document it. Make it work.

### Concern: "Graph-based" is not a benefit

Users don't care that we use a graph. They care about:
- Finding where data comes from
- Tracing API calls to handlers
- Understanding code without reading it all

The messaging should be about outcomes, not architecture.

---

## The Vision Check

The CLAUDE.md says: **"AI should query the graph, not read code."**

After today's demo, I can say: **We're getting there.**

The VS Code extension is actually the sleeper feature. An AI agent could theoretically use it to navigate code visually. The MCP tools let Claude query without opening files.

But we're not done. The graph is only useful if:
1. It's complete (coverage gaps = unusable)
2. It's queryable (UX matters)
3. It's fast (can't wait minutes)

We've achieved #1 and #2 for JavaScript/TypeScript Express apps. #3 is acceptable for small-medium codebases.

---

## Final Verdict

| Question | Answer |
|----------|--------|
| Is it ready for public release? | **YES** |
| Is it ready for production at scale? | **Not yet** |
| Should we market it as "beta"? | **Yes** |
| Does the core value prop work? | **Absolutely** |

### Action Items for Release

1. [ ] Update version to `0.2.0-beta` in all package.json files
2. [ ] Update CHANGELOG.md with all features
3. [ ] Update README.md to remove alpha warning, add real capabilities
4. [ ] Document CLI installation clearly
5. [ ] Add VS Code extension installation docs
6. [ ] Create 60-second demo video (optional but powerful)
7. [ ] Tag and release on GitHub

### Post-Release

1. [ ] Blog post: "Grafema: Query your code, don't read it"
2. [ ] Submit to Hacker News (Show HN)
3. [ ] Get user feedback on real codebases
4. [ ] Prioritize based on actual usage patterns

---

## One More Thing

This project started with a thesis: AI wastes tokens reading code that could be queried.

Today, that thesis was validated. On a real project. With real code. The graph answered questions that would have required reading 10+ files.

**That's not an alpha. That's a product.**

Ship it.

— Steve
