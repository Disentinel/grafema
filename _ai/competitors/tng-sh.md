# tng.sh — Competitor Analysis

**Date:** 2026-02-16
**Threat level:** LOW (2/10)
**Website:** https://tng.sh/
**Company:** Binary Dreams LLC (Austin, TX)
**Category:** AI-powered test generation

## What It Is

TNG.sh ("The Next Generation") is an AI-powered test generator. Tagline: "The Expert Guardrail". Targets "vibe coders" — developers who ship fast but skip writing tests.

## How It Works

4-phase pipeline:

1. **AST parsing** — Tree-sitter (JS/TS), `go/ast` (Go), built-in parser (Ruby/Rails)
2. **Context extraction** — functions, handlers, ORM patterns, middleware, auth
3. **Framework detection** — 100+ libraries (Jest, Express, Prisma, Gin, GORM, etc.)
4. **AI generation** — sends context to LLM, receives generated tests

Requires API key via `app.tng.sh` (SaaS model — code leaves the machine).

## Language Support

| Language | Parser | Public Repo |
|----------|--------|-------------|
| Rails/Ruby | Built-in | [tng-rails-public](https://github.com/tng-sh/tng-rails-public) |
| Go | `go/ast` | [tng-go-public](https://github.com/tng-sh/tng-go-public) |
| JS/TS | Tree-sitter | [tng-js-public](https://github.com/tng-sh/tng-js-public) |
| Python | Unknown | Mentioned, no public repo |

## Product Maturity

- **All repositories: 0 stars, 0 forks** (as of Feb 2026)
- Created October 2025
- 3 commits in Rails repo
- Marketing claims: "73% reduction in production incidents", "12 bugs per 1,000 LOC" — no independent validation
- Blog on Blogspot + Medium — typical early-stage startup pattern
- No Windows support
- IntelliJ plugin exists: https://plugins.jetbrains.com/plugin/28919-tng-test-generator

## Strengths

- Broad framework coverage (100+ libraries auto-detected)
- Convenient CLI with interactive terminal UI
- Auto-detection of test framework and configuration
- Focused on a specific use case (test generation) — clear value prop
- Multi-language from day one

## Weaknesses

- AST parsing without semantic understanding (no data flow, no dependency graph)
- Does not build a persistent code representation
- Relies on LLM for "understanding" — AST only extracts structure
- SaaS-only (API key required) — code leaves the machine
- Very early stage, may not reach product-market fit

## Comparison with Grafema

| Dimension | Grafema | tng.sh |
|-----------|---------|--------|
| **Goal** | Code understanding via semantic graph | Test generation |
| **Approach** | Semantic graph + Datalog queries | AST parsing + LLM |
| **Persistence** | Graph stored, queryable across sessions | One-shot analysis |
| **Data flow** | Yes (value tracing, assignments) | No |
| **Cross-file analysis** | Yes (imports, dependencies, modules) | No (file-level only) |
| **Primary consumer** | AI agents, developers | Developers |
| **Deployment** | Open source, runs locally | SaaS, API key required |
| **Target codebases** | Massive legacy, untyped | Greenfield, modern frameworks |
| **Languages** | JS (expanding) | Ruby, Go, JS/TS, Python |

## Threat Assessment

**Not a competitor. Different market category.**

1. **Different markets.** TNG.sh is a test generation tool. Grafema is a semantic code understanding platform. Comparing them is like comparing ESLint and IntelliJ — different product categories entirely.

2. **Different analysis depth.** TNG does shallow AST parsing to extract context for an LLM. Grafema builds a deep semantic graph with data flow, scope chains, cross-file dependencies. TNG cannot answer "where does this variable's value come from?" — Grafema can.

3. **Different target codebases.** TNG is optimized for modern frameworks (Rails, Express, Gin) with good structure. Grafema targets massive legacy codebases where frameworks are custom or absent.

4. **Very early stage.** 0 stars, 0 forks, 3 commits, marketing blog with no user testimonials. May not survive to product-market fit.

5. **SaaS model is limiting.** For enterprise legacy codebases, sending code to an external server is often unacceptable. Grafema runs locally.

## Potential Synergy

TNG.sh is a potential **downstream consumer** of Grafema, not a competitor. A test generator backed by Grafema's semantic graph would produce significantly better tests than one backed by shallow AST parsing — understanding data flow, dependencies, and cross-file relationships enables smarter test case generation.

## Sources

- https://tng.sh/
- https://tng.sh/features
- https://tng.sh/how-it-works
- https://blog.tng.sh/2026/01/the-vibe-coders-redemption-how-tngsh.html
- https://github.com/tng-sh/tng-rails-public
- https://github.com/tng-sh/tng-go-public
- https://github.com/tng-sh/tng-js-public
- https://binarydreams.org/
