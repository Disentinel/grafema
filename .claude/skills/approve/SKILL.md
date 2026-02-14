# /approve — Push PR to Auto-Merge

## When to Use

User says `/approve` after reviewing a completed task in a worker worktree.
This replaces the manual merge-to-main workflow.

## What It Does

1. Pushes current branch to origin
2. Creates a PR against main
3. Enables auto-merge (GitHub merges automatically when CI passes)
4. Updates Linear issue status to "In Review"

## Prerequisites

- Must be on a task branch (e.g., `task/REG-XXX`), NOT on `main`
- All changes must be committed (no uncommitted changes)
- Steve Jobs review should have been completed before calling this

## Steps

### 1. Validate State

```bash
# Get current branch
BRANCH=$(git branch --show-current)

# Must not be on main
if [ "$BRANCH" = "main" ]; then
  echo "ERROR: Cannot approve from main branch"
  exit 1
fi

# Must have clean working tree
if [ -n "$(git status --porcelain)" ]; then
  echo "ERROR: Uncommitted changes exist. Commit first."
  exit 1
fi
```

### 2. Push Branch

```bash
git push -u origin "$BRANCH"
```

### 3. Create PR

Create PR with title and body derived from the task:

- **Title**: Extract from Linear issue if REG-XXX is in branch name, otherwise use branch name
- **Body**: Include summary of changes from commits on this branch (vs main)

```bash
# Get commits unique to this branch
git log main..HEAD --oneline

# Create PR
gh pr create --title "..." --body "..."
```

If PR already exists, skip creation and use existing PR.

### 4. Enable Auto-Merge

```bash
# Get PR number
PR_URL=$(gh pr view --json url --jq '.url')

# Enable auto-merge with merge commit strategy
gh pr merge --auto --merge
```

This tells GitHub: "merge this PR automatically when all required status checks pass."

### 5. Update Linear

Extract issue ID from branch name (e.g., `task/REG-123` → `REG-123`).

Update Linear issue status to **In Review** using `mcp__linear__update_issue`.

### 6. Report

Print summary:
- PR URL
- Auto-merge status: enabled
- CI checks: running (will merge when green)
- Linear status: updated to "In Review"

## What Happens Next

- GitHub CI runs automatically (Tests, Typecheck & Lint, Build, Version Sync)
- When ALL checks pass → PR auto-merges to main
- If merge conflict → auto-merge fails, GitHub sends notification on the PR
- User resolves conflict by telling worker to rebase: `git rebase main && git push --force-with-lease`

## Notifications

Conflicts and CI failures appear as:
- GitHub notification (bell icon on github.com)
- Email (if GitHub email notifications enabled)
- Failed status check on the PR page
- Comment on PR explaining the failure reason

## Multiple Workers

Multiple workers can `/approve` simultaneously. Since `strict: false` is set in branch protection:
- All PRs run CI concurrently against current main
- PRs merge in order as CI completes
- No need to wait for one PR to merge before the next starts CI
- If a merge conflict occurs after another PR merges, only that specific PR needs a rebase
