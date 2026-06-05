/**
 * Standardized error formatting for CLI commands - REG-157
 *
 * Provides consistent error messages across all CLI commands.
 * Format:
 *   ✗ Main error message (1 line, concise)
 *
 *   → Next action 1
 *   → Next action 2
 */

/**
 * Print a standardized error message and exit.
 *
 * @param title - Main error message (should be under 80 chars)
 * @param nextSteps - Optional array of actionable suggestions
 * @returns never - always calls process.exit(1)
 *
 * @example
 * exitWithError('No graph database found', [
 *   'Run: grafema analyze'
 * ]);
 */
export function exitWithError(title: string, nextSteps?: string[]): never {
  console.error(`✗ ${title}`);

  if (nextSteps && nextSteps.length > 0) {
    console.error('');
    for (const step of nextSteps) {
      console.error(`→ ${step}`);
    }
  }

  process.exit(1);
}

/**
 * Emit a not-found result under `--json`.
 *
 * The `--json` contract is that stdout is ALWAYS parseable JSON, so scripts and
 * agents consuming a command's output never choke on empty stdout. On a
 * not-found, this prints the machine-readable payload to stdout and the
 * human-readable note to stderr (the same convention `impact`/`wtf` use). The
 * caller should `return` immediately afterward so the process exits 0 and any
 * `finally` block (e.g. closing the backend) still runs — unlike
 * {@link exitWithError}, which calls `process.exit(1)` and skips `finally`.
 *
 * @param payload - command-specific null/empty result object; should mirror the
 *   shape the command emits on success (e.g. `{ node: null, ... }`).
 * @param humanNote - human-readable message; written to stderr, never stdout.
 *
 * @example
 * if (!node) {
 *   if (options.json) {
 *     emitJsonNotFound({ node: null }, `Node not found: "${id}"`);
 *     return;
 *   }
 *   exitWithError(`Node not found: "${id}"`, ['Use: grafema query "<name>"']);
 * }
 */
export function emitJsonNotFound(payload: unknown, humanNote: string): void {
  process.stderr.write(`${humanNote}\n`);
  console.log(JSON.stringify(payload, null, 2));
}
