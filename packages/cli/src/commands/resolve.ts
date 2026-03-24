/**
 * Resolve command — Re-run resolution phase on an already-analyzed project.
 *
 * Command definition only. Execution logic is in resolveAction.ts.
 */

import { Command } from 'commander';
import { resolveAction } from './resolveAction.js';


export const resolveCommand = new Command('resolve')
  .description('Re-run resolution phase on an already-analyzed project')
  .argument('[path]', 'Project path', '.')
  .option('-q, --quiet', 'Suppress progress output')
  .option('-v, --verbose', 'Show verbose logging')
  .option('--debug', 'Enable debug mode')
  .option('--log-level <level>', 'Set log level (silent, errors, warnings, info, debug)')
  .option('--log-file <path>', 'Write all log output to a file')
  .option('--no-auto-start', 'Do not auto-start RFDB server (require manual start)')
  .addHelpText('after', `
Examples:
  grafema resolve                Re-run resolution on current project
  grafema resolve ./my-project   Re-run resolution on specific directory
  grafema resolve -v             Verbose output with progress details
`)
  .action(resolveAction);
