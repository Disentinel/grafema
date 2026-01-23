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
