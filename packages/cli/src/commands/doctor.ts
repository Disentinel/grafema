/**
 * Doctor command - Diagnose Grafema setup issues
 *
 * Checks (in order):
 * 1. Initialization (.grafema directory, config file)
 * 2. Config validity (syntax, plugin names)
 * 3. Entrypoints (service paths exist)
 * 4. Server status (RFDB server running)
 * 5. Database exists and has data
 * 6. Graph statistics
 * 7. Graph connectivity
 * 8. Graph freshness
 * 9. Version information
 */

import { Command } from 'commander';
import { resolve } from 'path';
import {
  checkGrafemaInitialized,
  checkServerStatus,
  checkConfigValidity,
  checkEntrypoints,
  checkDatabaseExists,
  checkGraphStats,
  checkConnectivity,
  checkFreshness,
  checkVersions,
} from './doctor/checks.js';
import { formatReport, buildJsonReport } from './doctor/output.js';
import type { DoctorOptions, DoctorCheckResult } from './doctor/types.js';

export const doctorCommand = new Command('doctor')
  .description('Diagnose Grafema setup issues')
  .option('-p, --project <path>', 'Project path', '.')
  .option('-j, --json', 'Output as JSON')
  .option('-q, --quiet', 'Only show failures')
  .option('-v, --verbose', 'Show detailed diagnostics')
  .addHelpText('after', `
Examples:
  grafema doctor                 Run all diagnostic checks
  grafema doctor --verbose       Show detailed diagnostics
  grafema doctor --quiet         Only show failures
  grafema doctor --json          Output diagnostics as JSON
`)
  .action(async (options: DoctorOptions) => {
    const projectPath = resolve(options.project);
    const checks: DoctorCheckResult[] = [];

    // Level 1: Prerequisites (fail-fast)
    const initCheck = await checkGrafemaInitialized(projectPath);
    checks.push(initCheck);

    if (initCheck.status === 'fail') {
      // Can't continue without initialization
      outputResults(checks, projectPath, options);
      process.exit(1);
    }

    // Level 2: Configuration
    checks.push(await checkConfigValidity(projectPath));
    checks.push(await checkEntrypoints(projectPath));

    // Server status (needed for Level 3 checks)
    const serverCheck = await checkServerStatus(projectPath);
    checks.push(serverCheck);

    // Level 3: Graph Health (requires database and optionally server)
    checks.push(await checkDatabaseExists(projectPath));

    if (serverCheck.status === 'pass') {
      // Server is running - can do full health checks
      checks.push(await checkGraphStats(projectPath));
      checks.push(await checkConnectivity(projectPath));
      checks.push(await checkFreshness(projectPath));
    }

    // Level 4: Informational
    checks.push(await checkVersions(projectPath));

    // Output results
    outputResults(checks, projectPath, options);

    // Exit code
    const failCount = checks.filter(c => c.status === 'fail').length;
    const warnCount = checks.filter(c => c.status === 'warn').length;

    if (failCount > 0) {
      process.exit(1);  // Critical issues
    } else if (warnCount > 0) {
      process.exit(2);  // Warnings only
    }
    // Exit 0 for all pass
  });

function outputResults(
  checks: DoctorCheckResult[],
  projectPath: string,
  options: DoctorOptions
): void {
  if (options.json) {
    const report = buildJsonReport(checks, projectPath);
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatReport(checks, options));
  }
}
