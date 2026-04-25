# REG-385: CLI/dev workflow: detect missing Node in PATH (nvm) and provide guidance

## Context
When users have Node.js installed via nvm (Node Version Manager), the `node` binary may not be available in PATH in certain contexts (e.g., when running from a non-interactive shell, cron, or IDE terminal that doesn't source nvm). This causes Grafema CLI to fail with confusing errors.

## Request
Detect when Node.js is missing from PATH (particularly in nvm setups) and provide clear, actionable guidance to the user about how to fix it.

## Status
Linear: Backlog → In Progress
