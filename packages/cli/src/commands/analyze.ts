/**
 * Analyze command — Run project analysis via Orchestrator.
 *
 * Command definition only. Execution logic is in analyzeAction.ts.
 */

import { Command } from 'commander';
import { analyzeAction } from './analyzeAction.js';


export const analyzeCommand = new Command('analyze')
  .description('Run project analysis')
  .argument('[path]', 'Project path to analyze', '.')
  .option('-s, --service <name>', 'Analyze only a specific service')
  .option('-e, --entrypoint <path>', 'Override entrypoint (bypasses auto-detection)')
  .option('-c, --clear', 'Clear existing database before analysis')
  .option('-q, --quiet', 'Suppress progress output')
  .option('-v, --verbose', 'Show verbose logging')
  .option('--debug', 'Enable debug mode (writes diagnostics.log)')
  .option('--log-level <level>', 'Set log level (silent, errors, warnings, info, debug)')
  .option('--log-file <path>', 'Write all log output to a file')
  .option('--strict', 'Enable strict mode (fail on unresolved references)')
  .option('--auto-start', 'Auto-start RFDB server if not running')
  .option('--engine <name>', 'Analysis engine: v1 (default) or v2 (core-v2 walker)')
  .addHelpText('after', `
Examples:
  grafema analyze                Analyze current project
  grafema analyze ./my-project   Analyze specific directory
  grafema analyze --clear        Clear database and rebuild from scratch
  grafema analyze -s api         Analyze only "api" service (monorepo)
  grafema analyze -v             Verbose output with progress details
  grafema analyze --debug        Write diagnostics.log for debugging
  grafema analyze --log-file out.log  Write all logs to a file
  grafema analyze --strict       Fail on unresolved references (debugging)
  grafema analyze --auto-start   Auto-start server (useful for CI)

Note: Start the server first with: grafema server start
`)
  .action(analyzeAction);
