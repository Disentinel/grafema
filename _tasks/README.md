# _tasks: Design Decision Records

This directory contains records of architectural decisions and technical explorations made during Grafema development.

## What is this?

Instead of traditional Architecture Decision Records (ADRs), we use a "Zoo Development" approach — a methodology where complex problems are analyzed through multiple expert perspectives before implementation.

The idea is inspired by [Ivan Tarantsov's All-Star Zoo](https://tarantsov.com/all-star-zoo/) concept.

## How it works

For significant technical decisions, we create a task directory containing:

1. **User request** — original problem statement
2. **Expert analyses** — the problem examined from different angles (architecture, testing, implementation, product vision)
3. **Synthesis** — technical lead summary combining insights into actionable plan
4. **Implementation reports** — what was actually built and why

## Why keep this public?

- **Transparency** — shows that architectural decisions are deliberate, not accidental
- **Onboarding** — helps new contributors understand *why* the code is structured this way
- **Learning** — documents the reasoning process, not just the outcome

## Structure

```
_tasks/
├── YYYY-MM-DD-task-name/
│   ├── 001-user-request.md
│   ├── 002-expert-plan.md
│   ├── 003-expert-analysis.md
│   ├── ...
│   └── 00N-final-summary.md
```

## Note

These records reflect the actual development process, including exploration of alternatives and dead ends. They are preserved as-is for authenticity.
