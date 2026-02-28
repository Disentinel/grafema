---
name: ship
description: |
  Build all packages, reinstall VS Code extension, commit and push.
  Use when: user says "ship", or wants to build+install+commit+push in one go.
user-invocable: true
disable-model-invocation: true
---

# Ship: Build, Install, Commit, Push

Full pipeline: build all packages, reinstall VS Code extension from source, commit changes, push to remote.

## Steps

1. **Build all packages**: `pnpm build` from monorepo root
2. **Reinstall VS Code extension**: package vsix, install with --force, clean up
3. **Commit**: stage changed files (NOT dist/, NOT .vsix), create commit with user-provided message or auto-generated
4. **Push**: `git push` to current branch remote

## Execution

Run these steps sequentially. If any step fails, STOP and report the error.

### Step 1: Build
```bash
cd /Users/vadimr/grafema && pnpm build
```
If build fails, stop immediately and show the error.

### Step 2: Reinstall VS Code extension
```bash
cd /Users/vadimr/grafema/packages/vscode && \
npx vsce package --no-dependencies && \
code --install-extension grafema-explore-*.vsix --force && \
rm grafema-explore-*.vsix
```

### Step 3: Commit
- Run `git status` and `git diff --staged` to see changes
- Stage source files only (no dist/, no .vsix, no node_modules)
- If user provided $ARGUMENTS, use it as commit message
- Otherwise, auto-generate a concise commit message from the diff
- Include `Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>`

### Step 4: Push
```bash
git push
```

## Important
- NEVER commit dist/ or .vsix files
- If there are no changes to commit, skip steps 3 and 4
- Always check build output for errors before proceeding
