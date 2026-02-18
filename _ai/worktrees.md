# Git Worktree Workflow

**CRITICAL: Worker Slots Pattern**

Fixed number of worktree "slots" for parallel work. Each slot runs persistent Claude Code instance.

## Initial Setup (done once)

```bash
cd /Users/vadimr/grafema
git worktree add ../grafema-worker-1
git worktree add ../grafema-worker-2
...
git worktree add ../grafema-worker-8
```

Each worker runs Claude Code in its own terminal. Workers persist across tasks.

## Starting New Task in a Worker

User will tell Claude which task to work on. Claude then:

```bash
# Pull latest changes
git fetch origin
git checkout main
git pull

# Create task branch
git checkout -b task/REG-XXX
```

**IMPORTANT:** Git operations (fetch, checkout, branch creation) are safe and require NO user confirmation.

**CRITICAL — After branch created, IMMEDIATELY:**
1. **Update Linear → In Progress** (use `mcp__linear__update_issue` with `state: "In Progress"`)
2. Save task description to `_tasks/REG-XXX/001-user-request.md`

Do NOT start coding until Linear status is updated.

## Finishing Task

1. Code ready → run **4-Review** (Batch 1: Вадим auto ∥ Steve, Batch 2: Dijkstra ∥ Uncle Bob)
2. If ANY REJECT → fix issues, don't bother user, re-run ALL 4 reviews
3. If ALL 4 APPROVE → present combined review summary to user (real Вадим)
4. User confirms → create PR, Linear status → **In Review**
5. CI must pass. If CI fails → fix, push, wait for green
6. User will merge and `/clear` to start next task

## Review & Merge Process

**Two-stage review:**

| Stage | Who | Focus | On REJECT |
|-------|-----|-------|-----------|
| 1a. Вадим auto | Completeness | Does it deliver what was asked? | Fix, retry all 4 |
| 1b. Steve | Vision | Architecture, vision alignment | Fix, retry all 4 |
| 1c. Dijkstra | Correctness | Edge cases, input enumeration | Fix, retry all 4 |
| 1d. Uncle Bob | Code quality | Structure, naming, readability | Fix, retry all 4 |
| 2. Вадим (human) | Final | Confirms or overrides | Fix per feedback, retry from stage 1 |

**Stage 1 — 4-Review (2 batches of 2 parallel):**
- Batch 1: Вадим auto ∥ Steve
- Batch 2: Dijkstra ∥ Uncle Bob
- Each reviewer focuses on ONE perspective — no multi-tasking
- ANY REJECT → fix, then re-run ALL 4 (not just the failed one)

**Stage 2 — Вадим manual (final confirmation):**
- User sees combined review summary from all 4 reviewers
- User confirms or rejects with feedback
- If confirmed → merge to main, update Linear → **Done**

After merge, task branch can be deleted (optional cleanup).

## Directory Structure

```
/Users/vadimr/
├── grafema/              # Main repo (coordination, PR reviews, releases)
├── grafema-worker-1/     # Worker slot 1 (persistent)
├── grafema-worker-2/     # Worker slot 2 (persistent)
...
├── grafema-worker-8/     # Worker slot 8 (persistent)
```

## Rules

1. **Never work in main repo** — only in worker slots
2. **Workers persist across tasks** — no need to recreate
3. **One worker = one terminal = one CC instance** — stays running
4. **Task switching within worker:**
   ```bash
   # After /clear
   git checkout main
   git pull
   git checkout -b task/REG-YYY
   ```
5. **Commit often** — branches are in git, safe even if worker reset

## Managing Workers

Check active workers:
```bash
cd /Users/vadimr/grafema
git worktree list
```

If worker gets corrupted, recreate it:
```bash
git worktree remove ../grafema-worker-N --force
git worktree add ../grafema-worker-N
```
