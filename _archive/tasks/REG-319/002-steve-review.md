# Steve Jobs Review: Documentation UX Evaluation

**Date:** 2026-02-03
**Reviewer:** Steve Jobs (Product Design)
**Files Reviewed:**
- `docs/configuration.md`
- `docs/project-onboarding.md`
- `docs/plugin-development.md`

---

## Overall Verdict: Mixed

The documentation is functional but doesn't delight. It explains *what* but rarely inspires *why*. A user can follow these docs, but they won't feel excited about Grafema after reading them. That's a problem.

---

## 1. First Contact

### configuration.md

**What works:** Opens with `grafema init` immediately. Good. User can do something in 5 seconds.

**What doesn't work:** The document title is "Configuration Reference". Nobody wakes up excited to read a reference. References are for when you already know what you want. This should lead with a benefit: "Configure Grafema to Understand Your Codebase".

The directory structure diagram appears before the user knows why they should care about any of these files. Lead with the outcome, not the plumbing.

### project-onboarding.md

**Critical problem:** The document is in Russian. This immediately alienates the English-speaking developer majority. If Grafema is targeting massive legacy codebases globally, English must be the primary language.

The pipeline diagram is cute but abstract. Show me a before/after. Show me what my codebase looks like in Grafema. The diagram tells me steps; it doesn't tell me transformation.

### plugin-development.md

Also in Russian. Same problem.

The architecture diagram is information-dense but context-poor. What does it FEEL like to write a plugin? Is it 20 minutes or 2 days? The doc doesn't say.

**Verdict for First Contact: C-**

A developer landing here will understand the mechanics but won't feel the magic. The language barrier is unacceptable for an international tool.

---

## 2. Progressive Disclosure

### configuration.md

This actually does progressive disclosure well:
1. Quick Start (just run `grafema init`)
2. Directory structure (now you know where things live)
3. Full schema (when you need the details)
4. Plugin tables (reference material)
5. Examples (concrete scenarios)

**Good pattern.** This is how documentation should flow.

### project-onboarding.md

The 5-step flow (SETUP -> ANALYZE -> ASSESS -> GUARANTEES -> CI/CD) is excellent structurally. Each step builds on the previous.

But Step 3 ("Assessment") jumps into Datalog queries without explaining what they mean. A user new to Grafema has no idea what `violation(X) :- node(X, "CALL"), \+ edge(X, _, "CALLS").` means. This is a cliff, not a step.

### plugin-development.md

Goes from architecture overview to full code example. That's a massive jump. Where's the middle ground? I want to see:
1. The simplest possible plugin (10 lines)
2. Then a medium plugin (30 lines)
3. Then the full Fastify example (100+ lines)

Currently it's: theory -> full production code. Most users will get lost.

**Verdict for Progressive Disclosure: B-**

configuration.md gets it. The others have good structure but bad granularity.

---

## 3. Clarity

### Inconsistent Language

The most glaring issue: **two documents are in Russian, one is in English.** This is confusing and unprofessional. Pick one language for all docs.

### Unexplained Jargon

- "Datalog queries" - What is Datalog? Where do I learn it?
- "violation(X)" - What does this syntax mean?
- "enrichment phase" - Why is it called enrichment? What's being enriched?
- "semantic nodes" - What makes a node semantic vs non-semantic?

These terms appear repeatedly without definition. The docs assume familiarity that new users don't have.

### Good Clarity Moments

- The plugin tables in configuration.md are clear and useful
- The checklist at the end of project-onboarding.md is practical
- The "when to use" guidance in plugin-development.md is helpful

### Code Examples

The Fastify plugin example is well-commented and educational. But it's 160 lines of JavaScript. Most developers will skim it. Highlight the 5 key lines they need to understand, then show the full code.

**Verdict for Clarity: C+**

Language inconsistency kills credibility. Jargon without glossary frustrates users.

---

## 4. Delight

This is where the documentation fails most significantly.

**Where's the promise?**

Grafema's vision is powerful: "AI should query the graph, not read code." That's exciting. But these docs read like technical manuals, not invitations to a better world.

Consider this opening for project-onboarding.md:

> "Your codebase has thousands of files. Where does user data flow? Which endpoints call the database? Grafema answers these questions in seconds, not hours. Here's how to get started."

Instead, we get:

> "This guide will help implement Grafema in an existing project..."

One makes you want to try it. One makes you feel like you're filling out paperwork.

**No screenshots or visualizations**

What does a Grafema graph look like? What does the CLI output? What does "coverage" look like in practice? Show me. Seeing is believing.

**No success stories**

"We analyzed a 500,000 LOC codebase and found 47 SQL injection vulnerabilities in 3 minutes." That would be compelling. Where are statements like this?

**No comparison**

How long does manual code review take vs Grafema? What would these tasks cost without the tool? The docs don't make the case.

**Verdict for Delight: D**

The documentation informs but doesn't inspire. Users learn HOW but never feel WHY.

---

## 5. Friction Points

### Show-stoppers

1. **Language inconsistency** - Two docs in Russian, one in English. Fix immediately.

2. **No "Hello World" plugin** - The simplest plugin example is 160 lines. Create a 15-line example that just logs "Hello from my plugin" to prove the system works.

3. **Datalog cliff** - Queries appear without explanation. Link to a Datalog primer or write one.

### Annoyances

4. **No troubleshooting in configuration.md** - What happens when `grafema init` fails? When config is invalid? The doc only covers happy path.

5. **MCP examples before CLI** - In project-onboarding, MCP tool calls appear alongside CLI commands. Most users will try CLI first. Lead with CLI, show MCP as alternative.

6. **No copy-paste commands for common queries** - The Datalog queries in project-onboarding should be in a separate cheat sheet. Nobody will remember `violation(X) :- node(X, "CALL"), \+ edge(X, _, "CALLS").`

7. **Fixture example is incomplete** - The test fixture in plugin-development shows a Fastify app but doesn't show the expected graph output. What SHOULD the test assert? Show the expected nodes.

### Missing Entirely

8. **No glossary** - Terms like "enrichment", "semantic node", "violation" need definitions

9. **No FAQ** - "Can I use Grafema with TypeScript?" "Does it work in a monorepo?" "What's the performance on large codebases?"

10. **No "Next Steps" after CI/CD** - The onboarding guide ends with CI integration. Then what? How do I get more value over time?

---

## Specific Recommendations

### Immediate (before release)

1. **Translate all docs to English** - Maintain a single source of truth
2. **Add a 15-line "Hello World" plugin** - Lower the barrier to custom plugins
3. **Write 1-paragraph intro explaining what Grafema gives you** - Before any technical content

### Short-term

4. **Create a Datalog cheat sheet** - Common queries with plain-English explanations
5. **Add screenshots** - Show what analysis output looks like
6. **Add a glossary** - Define every domain-specific term

### Medium-term

7. **Restructure plugin guide** - Simple -> Medium -> Complex examples
8. **Add FAQ section** - Answer the questions users will ask
9. **Write a "Why Grafema" page** - The emotional case, not just the technical one

---

## The Bottom Line

These docs will help existing users complete specific tasks. They won't convert skeptics or excite newcomers.

Documentation is product. If the docs don't make someone want to try Grafema, they've failed regardless of technical accuracy.

The good news: the structure is solid. The content is correct. What's missing is soul.

Make me feel like I'm about to discover something powerful, not like I'm reading a manual for a dishwasher.

**Rating: C+**

Functional but uninspiring. Would not demo.

---

*"Design is not just what it looks like and feels like. Design is how it works."*
*But if nobody wants to try it, it doesn't matter how well it works.*
