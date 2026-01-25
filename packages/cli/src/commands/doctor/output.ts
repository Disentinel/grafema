/**
 * Output formatting utilities for `grafema doctor` command - REG-214
 */

import type { DoctorCheckResult, DoctorReport } from './types.js';

// ANSI colors (matching existing CLI style)
const COLORS = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
  reset: '\x1b[0m',
};

const STATUS_ICONS: Record<string, string> = {
  pass: `${COLORS.green}✓${COLORS.reset}`,
  warn: `${COLORS.yellow}⚠${COLORS.reset}`,
  fail: `${COLORS.red}✗${COLORS.reset}`,
  skip: `${COLORS.dim}○${COLORS.reset}`,
};

/**
 * Format a single check result for console output.
 */
export function formatCheck(result: DoctorCheckResult, verbose: boolean): string {
  const icon = STATUS_ICONS[result.status];
  let output = `${icon} ${result.message}`;

  if (result.recommendation) {
    output += `\n  ${COLORS.dim}→${COLORS.reset} ${result.recommendation}`;
  }

  if (verbose && result.details) {
    const detailStr = JSON.stringify(result.details, null, 2)
      .split('\n')
      .map(line => `    ${COLORS.dim}${line}${COLORS.reset}`)
      .join('\n');
    output += `\n${detailStr}`;
  }

  return output;
}

/**
 * Format full report for console.
 */
export function formatReport(
  checks: DoctorCheckResult[],
  options: { quiet?: boolean; verbose?: boolean }
): string {
  const lines: string[] = [];

  if (!options.quiet) {
    lines.push('Checking Grafema setup...');
    lines.push('');
  }

  for (const check of checks) {
    if (options.quiet && check.status === 'pass') continue;
    lines.push(formatCheck(check, options.verbose || false));
  }

  // Summary
  const failCount = checks.filter(c => c.status === 'fail').length;
  const warnCount = checks.filter(c => c.status === 'warn').length;

  lines.push('');
  if (failCount > 0) {
    lines.push(`${COLORS.red}Status: ${failCount} error(s), ${warnCount} warning(s)${COLORS.reset}`);
  } else if (warnCount > 0) {
    lines.push(`${COLORS.yellow}Status: ${warnCount} warning(s)${COLORS.reset}`);
  } else {
    lines.push(`${COLORS.green}Status: All checks passed${COLORS.reset}`);
  }

  return lines.join('\n');
}

/**
 * Build JSON report structure.
 */
export function buildJsonReport(
  checks: DoctorCheckResult[],
  projectPath: string
): DoctorReport {
  const failCount = checks.filter(c => c.status === 'fail').length;
  const warnCount = checks.filter(c => c.status === 'warn').length;

  const status = failCount > 0 ? 'error' : warnCount > 0 ? 'warning' : 'healthy';
  const recommendations = checks
    .filter(c => c.recommendation)
    .map(c => c.recommendation as string);

  // Extract versions from versions check
  const versionsCheck = checks.find(c => c.name === 'versions');
  const versions = (versionsCheck?.details as { cli?: string; core?: string; rfdb?: string }) || {
    cli: 'unknown',
    core: 'unknown',
  };

  return {
    status,
    timestamp: new Date().toISOString(),
    project: projectPath,
    checks,
    recommendations,
    versions: {
      cli: versions.cli || 'unknown',
      core: versions.core || 'unknown',
      rfdb: versions.rfdb,
    },
  };
}
