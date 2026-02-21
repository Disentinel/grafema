/**
 * Check command - Check invariants/guarantees
 *
 * Supports two modes:
 * 1. Rule-based: Check YAML-defined guarantees (default)
 * 2. Built-in validators: --guarantee=<name> (e.g., --guarantee=node-creation)
 */

import { Command } from 'commander';
import { resolve, join } from 'path';
import { existsSync, readFileSync } from 'fs';
import {
  RFDBServerBackend,
  GuaranteeManager,
  GraphFreshnessChecker,
  IncrementalReanalyzer,
  DIAGNOSTIC_CATEGORIES,
} from '@grafema/core';
import type { GuaranteeGraph, DiagnosticCategoryKey } from '@grafema/core';
import { exitWithError } from '../utils/errorFormatter.js';


// Available built-in validators
// Add new validators here as they are implemented
const BUILT_IN_VALIDATORS: Record<string, { name: string; description: string; create: () => unknown }> = {
  // Example:
  // 'my-validator': {
  //   name: 'MyValidator',
  //   description: 'Validates something important',
  //   create: () => new MyValidator()
  // }
};

// Re-export for backward compatibility (deprecated - import from @grafema/core instead)
export { DIAGNOSTIC_CATEGORIES as CHECK_CATEGORIES };

export const checkCommand = new Command('check')
  .description('Check invariants/guarantees')
  .argument('[rule]', 'Specific rule ID to check (or "all" for all rules)')
  .option('-p, --project <path>', 'Project path', '.')
  .option('-f, --file <path>', 'Path to guarantees YAML file')
  .option('-g, --guarantee <name>', 'Run a built-in guarantee validator')
  .option('-j, --json', 'Output results as JSON')
  .option('-q, --quiet', 'Only output failures')
  .option('--list-guarantees', 'List available built-in guarantees')
  .option('--list-categories', 'List available diagnostic categories')
  .option('--skip-reanalysis', 'Skip automatic reanalysis of stale modules')
  .option('--fail-on-stale', 'Exit with error if stale modules found (CI mode)')
  .addHelpText('after', `
Examples:
  grafema check                          Run all guarantee checks
  grafema check connectivity             Check graph connectivity
  grafema check calls                    Check call resolution
  grafema check dataflow                 Check data flow integrity
  grafema check all                      Run all diagnostic categories
  grafema check --guarantee <name>           Run built-in validator
  grafema check --list-categories        List available categories
  grafema check --list-guarantees        List built-in guarantees
  grafema check --fail-on-stale          CI mode: fail if graph is stale
  grafema check -q                       Only show failures (quiet mode)
`)
  .action(
    async (
      rule: string | undefined,
      options: {
        project: string;
        file?: string;
        guarantee?: string;
        json?: boolean;
        quiet?: boolean;
        listGuarantees?: boolean;
        listCategories?: boolean;
        skipReanalysis?: boolean;
        failOnStale?: boolean;
      }
    ) => {
      // List available categories
      if (options.listCategories) {
        console.log('Available diagnostic categories:');
        console.log('');
        for (const [key, category] of Object.entries(DIAGNOSTIC_CATEGORIES)) {
          console.log(`  ${key}`);
          console.log(`    ${category.name}`);
          console.log(`    ${category.description}`);
          console.log(`    Usage: grafema check ${key}`);
          console.log('');
        }
        return;
      }

      // List available guarantees
      if (options.listGuarantees) {
        console.log('Available built-in guarantees:');
        console.log('');
        for (const [key, info] of Object.entries(BUILT_IN_VALIDATORS)) {
          console.log(`  ${key}`);
          console.log(`    ${info.description}`);
          console.log('');
        }
        return;
      }

      // Check if rule argument is a category name
      if (rule && (rule in DIAGNOSTIC_CATEGORIES || rule === 'all')) {
        await runCategoryCheck(rule, options);
        return;
      }

      // Run built-in guarantee validator
      if (options.guarantee) {
        const validatorInfo = BUILT_IN_VALIDATORS[options.guarantee];
        if (!validatorInfo) {
          const available = Object.keys(BUILT_IN_VALIDATORS).join(', ');
          exitWithError(`Unknown guarantee: ${options.guarantee}`, [
            `Available: ${available}`
          ]);
        }

        await runBuiltInValidator(options.guarantee, options.project, {
          json: options.json,
          quiet: options.quiet,
          skipReanalysis: options.skipReanalysis,
          failOnStale: options.failOnStale
        });
        return;
      }
      const projectPath = resolve(options.project);
      const grafemaDir = join(projectPath, '.grafema');
      const dbPath = join(grafemaDir, 'graph.rfdb');

      if (!existsSync(dbPath)) {
        exitWithError('No graph database found', ['Run: grafema analyze']);
      }

      const backend = new RFDBServerBackend({ dbPath, clientName: 'cli' });
      await backend.connect();

      // Check graph freshness
      const freshnessChecker = new GraphFreshnessChecker();
      const freshness = await freshnessChecker.checkFreshness(backend, projectPath);

      if (!freshness.isFresh) {
        if (options.failOnStale) {
          console.error(`✗ Graph is stale: ${freshness.staleCount} module(s) changed`);
          for (const stale of freshness.staleModules.slice(0, 5)) {
            console.error(`  ${stale.file} (${stale.reason})`);
          }
          if (freshness.staleModules.length > 5) {
            console.error(`  ... and ${freshness.staleModules.length - 5} more`);
          }
          console.error('');
          console.error('→ Run: grafema analyze');
          await backend.close();
          process.exit(1);
        }

        if (!options.skipReanalysis) {
          console.log(`Reanalyzing ${freshness.staleCount} stale module(s)...`);
          const reanalyzer = new IncrementalReanalyzer(backend, projectPath);
          const result = await reanalyzer.reanalyze(freshness.staleModules);
          console.log(`Reanalyzed ${result.modulesReanalyzed} module(s) in ${result.durationMs}ms`);
          console.log('');
        } else {
          console.warn(`Warning: ${freshness.staleCount} stale module(s) detected. Use --skip-reanalysis to suppress.`);
          for (const stale of freshness.staleModules.slice(0, 5)) {
            console.warn(`  - ${stale.file} (${stale.reason})`);
          }
          if (freshness.staleModules.length > 5) {
            console.warn(`  ... and ${freshness.staleModules.length - 5} more`);
          }
          console.log('');
        }
      } else if (!options.quiet) {
        console.log('Graph is fresh');
        console.log('');
      }

      try {
        const guaranteeGraph = backend as unknown as GuaranteeGraph;
        const manager = new GuaranteeManager(guaranteeGraph, projectPath);

        // Load guarantees from file if specified
        const guaranteesFile = options.file || join(grafemaDir, 'guarantees.yaml');
        if (existsSync(guaranteesFile)) {
          await manager.import(guaranteesFile);
        }

        // Get all guarantees
        const guarantees = await manager.list();

        if (guarantees.length === 0) {
          console.log('No guarantees found.');
          console.log('');
          console.log('Create guarantees in .grafema/guarantees.yaml or use --file option.');
          return;
        }

        // Filter to specific rule if requested
        const toCheck =
          rule && rule !== 'all'
            ? guarantees.filter((g) => g.id === rule || g.name === rule)
            : guarantees;

        if (toCheck.length === 0 && rule) {
          const available = guarantees.map((g) => g.id).join(', ');
          exitWithError(`Guarantee not found: ${rule}`, [
            `Available: ${available}`
          ]);
        }

        // Check all matching guarantees
        const results = await manager.checkAll();

        // Filter results to only requested rules
        const filteredResults = rule && rule !== 'all'
          ? {
              ...results,
              results: results.results.filter(
                (r) => toCheck.some((g) => g.id === r.guaranteeId)
              ),
            }
          : results;

        if (options.json) {
          console.log(JSON.stringify(filteredResults, null, 2));
        } else {
          if (!options.quiet) {
            console.log(`Checking ${filteredResults.results.length} guarantee(s)...`);
            console.log('');
          }

          for (const result of filteredResults.results) {
            if (options.quiet && result.passed) continue;

            const status = result.passed ? '✓' : '✗';
            const color = result.passed ? '\x1b[32m' : '\x1b[31m';
            const reset = '\x1b[0m';

            console.log(`${color}${status}${reset} ${result.guaranteeId}: ${result.name}`);

            if (!result.passed && result.violations.length > 0) {
              console.log(`  Violations (${result.violationCount}):`);
              for (const v of result.violations.slice(0, 10)) {
                // Prefer nodeId (semantic ID) for queryability
                const identifier = v.nodeId || (v.file ? `${v.file}${v.line ? `:${v.line}` : ''}` : '(unknown)');
                console.log(`    - ${identifier}`);
                if (v.name || v.type) {
                  console.log(`      ${v.name || ''} (${v.type || 'unknown'})`);
                }
              }
              if (result.violations.length > 10) {
                console.log(`    ... and ${result.violations.length - 10} more`);
              }
            }

            if (result.error) {
              console.log(`  Error: ${result.error}`);
            }
          }

          console.log('');
          console.log(`Summary: ${filteredResults.passed}/${filteredResults.total} passed`);

          if (filteredResults.failed > 0) {
            process.exit(1);
          }
        }
      } finally {
        await backend.close();
      }
    }
  );

/**
 * Run a built-in validator
 */
async function runBuiltInValidator(
  guaranteeName: string,
  projectPath: string,
  options: { json?: boolean; quiet?: boolean; skipReanalysis?: boolean; failOnStale?: boolean }
): Promise<void> {
  const resolvedPath = resolve(projectPath);
  const grafemaDir = join(resolvedPath, '.grafema');
  const dbPath = join(grafemaDir, 'graph.rfdb');

  if (!existsSync(dbPath)) {
    exitWithError('No graph database found', ['Run: grafema analyze']);
  }

  const backend = new RFDBServerBackend({ dbPath, clientName: 'cli' });
  await backend.connect();

  // Check graph freshness
  const freshnessChecker = new GraphFreshnessChecker();
  const freshness = await freshnessChecker.checkFreshness(backend, resolvedPath);

  if (!freshness.isFresh) {
    if (options.failOnStale) {
      console.error(`✗ Graph is stale: ${freshness.staleCount} module(s) changed`);
      for (const stale of freshness.staleModules.slice(0, 5)) {
        console.error(`  ${stale.file} (${stale.reason})`);
      }
      if (freshness.staleModules.length > 5) {
        console.error(`  ... and ${freshness.staleModules.length - 5} more`);
      }
      console.error('');
      console.error('→ Run: grafema analyze');
      await backend.close();
      process.exit(1);
    }

    if (!options.skipReanalysis) {
      console.log(`Reanalyzing ${freshness.staleCount} stale module(s)...`);
      const reanalyzer = new IncrementalReanalyzer(backend, resolvedPath);
      const result = await reanalyzer.reanalyze(freshness.staleModules);
      console.log(`Reanalyzed ${result.modulesReanalyzed} module(s) in ${result.durationMs}ms`);
      console.log('');
    } else {
      console.warn(`Warning: ${freshness.staleCount} stale module(s) detected. Use --skip-reanalysis to suppress.`);
      for (const stale of freshness.staleModules.slice(0, 5)) {
        console.warn(`  - ${stale.file} (${stale.reason})`);
      }
      if (freshness.staleModules.length > 5) {
        console.warn(`  ... and ${freshness.staleModules.length - 5} more`);
      }
      console.log('');
    }
  } else if (!options.quiet) {
    console.log('Graph is fresh');
    console.log('');
  }

  try {
    const validatorInfo = BUILT_IN_VALIDATORS[guaranteeName];
    if (!validatorInfo) {
      const available = Object.keys(BUILT_IN_VALIDATORS);
      if (available.length === 0) {
        exitWithError(`Unknown guarantee: ${guaranteeName}`, [
          'No built-in guarantees are currently available'
        ]);
      }
      exitWithError(`Unknown guarantee: ${guaranteeName}`, [
        `Available: ${available.join(', ')}`
      ]);
    }

    const validator = validatorInfo.create() as { execute: (ctx: { graph: unknown; projectPath: string }) => Promise<{ metadata?: unknown }> };
    const validatorName = validatorInfo.name;

    if (!options.quiet) {
      console.log(`Running ${validatorName}...`);
      console.log('');
    }

    const result = await validator.execute({
      graph: backend,
      projectPath: resolvedPath
    });

    const metadata = result.metadata as {
      summary?: {
        totalViolations: number;
        [key: string]: unknown;
      };
      issues?: Array<{
        type: string;
        severity: string;
        message: string;
        file?: string;
        line?: number;
        suggestion?: string;
      }>;
    };

    if (options.json) {
      console.log(JSON.stringify({
        guarantee: guaranteeName,
        passed: (metadata.summary?.totalViolations ?? 0) === 0,
        ...metadata
      }, null, 2));
    } else {
      const violations = metadata.summary?.totalViolations ?? 0;
      const issues = metadata.issues ?? [];

      if (violations === 0) {
        console.log('\x1b[32m✓\x1b[0m All checks passed');
      } else {
        console.log(`\x1b[31m✗\x1b[0m Found ${violations} violation(s):`);
        console.log('');

        for (const issue of issues.slice(0, 10)) {
          const _location = issue.file ? `${issue.file}${issue.line ? `:${issue.line}` : ''}` : '';
          console.log(`  \x1b[31m•\x1b[0m [${issue.type}] ${issue.message}`);
          if (issue.suggestion && !options.quiet) {
            console.log(`    Suggestion: ${issue.suggestion}`);
          }
        }

        if (issues.length > 10) {
          console.log(`  ... and ${issues.length - 10} more violations`);
        }
      }

      console.log('');
      if (violations > 0) {
        process.exit(1);
      }
    }
  } finally {
    await backend.close();
  }
}

/**
 * Run category-based diagnostic check
 */
async function runCategoryCheck(
  category: string,
  options: { project: string; json?: boolean; quiet?: boolean }
): Promise<void> {
  const resolvedPath = resolve(options.project);
  const grafemaDir = join(resolvedPath, '.grafema');
  const diagnosticsLogPath = join(grafemaDir, 'diagnostics.log');

  if (!existsSync(diagnosticsLogPath)) {
    exitWithError('No diagnostics found', [
      'Run: grafema analyze',
      'Diagnostics are collected during analysis'
    ]);
  }

  // Read diagnostics from log file (JSON lines format)
  const diagnosticsContent = readFileSync(diagnosticsLogPath, 'utf-8');
  const allDiagnostics = diagnosticsContent
    .split('\n')
    .filter(line => line.trim())
    .map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  // Filter diagnostics by category codes
  let filteredDiagnostics = allDiagnostics;
  if (category !== 'all') {
    if (!(category in DIAGNOSTIC_CATEGORIES)) {
      exitWithError(`Unknown category: ${category}`, [
        'Use --list-categories to see available options'
      ]);
    }
    const categoryKey = category as DiagnosticCategoryKey;
    const categoryInfo = DIAGNOSTIC_CATEGORIES[categoryKey];
    filteredDiagnostics = allDiagnostics.filter((d: any) =>
      categoryInfo.codes.includes(d.code)
    );
  }

  if (options.json) {
    console.log(JSON.stringify({
      category: category,
      total: filteredDiagnostics.length,
      diagnostics: filteredDiagnostics
    }, null, 2));
  } else {
    const categoryName = category === 'all'
      ? 'All Categories'
      : DIAGNOSTIC_CATEGORIES[category as DiagnosticCategoryKey].name;

    if (!options.quiet) {
      console.log(`Checking ${categoryName}...`);
      console.log('');
    }

    if (filteredDiagnostics.length === 0) {
      console.log('\x1b[32m✓\x1b[0m No issues found');
    } else {
      console.log(`\x1b[33m⚠\x1b[0m Found ${filteredDiagnostics.length} diagnostic(s):`);
      console.log('');

      // Group by severity
      const errors = filteredDiagnostics.filter((d: any) => d.severity === 'error' || d.severity === 'fatal');
      const warnings = filteredDiagnostics.filter((d: any) => d.severity === 'warning');
      const infos = filteredDiagnostics.filter((d: any) => d.severity === 'info');

      // Display errors first
      if (errors.length > 0) {
        console.log(`\x1b[31mErrors (${errors.length}):\x1b[0m`);
        for (const diag of errors.slice(0, 10)) {
          const location = diag.file ? `${diag.file}${diag.line ? `:${diag.line}` : ''}` : '';
          console.log(`  \x1b[31m•\x1b[0m [${diag.code}] ${diag.message}`);
          if (location) {
            console.log(`    ${location}`);
          }
          if (diag.suggestion && !options.quiet) {
            console.log(`    Suggestion: ${diag.suggestion}`);
          }
        }
        if (errors.length > 10) {
          console.log(`  ... and ${errors.length - 10} more errors`);
        }
        console.log('');
      }

      // Display warnings
      if (warnings.length > 0) {
        console.log(`\x1b[33mWarnings (${warnings.length}):\x1b[0m`);
        for (const diag of warnings.slice(0, 10)) {
          const location = diag.file ? `${diag.file}${diag.line ? `:${diag.line}` : ''}` : '';
          console.log(`  \x1b[33m•\x1b[0m [${diag.code}] ${diag.message}`);
          if (location) {
            console.log(`    ${location}`);
          }
          if (diag.suggestion && !options.quiet) {
            console.log(`    Suggestion: ${diag.suggestion}`);
          }
        }
        if (warnings.length > 10) {
          console.log(`  ... and ${warnings.length - 10} more warnings`);
        }
        console.log('');
      }

      // Display infos
      if (infos.length > 0 && !options.quiet) {
        console.log(`\x1b[36mInfo (${infos.length}):\x1b[0m`);
        for (const diag of infos.slice(0, 5)) {
          const location = diag.file ? `${diag.file}${diag.line ? `:${diag.line}` : ''}` : '';
          console.log(`  \x1b[36m•\x1b[0m [${diag.code}] ${diag.message}`);
          if (location) {
            console.log(`    ${location}`);
          }
        }
        if (infos.length > 5) {
          console.log(`  ... and ${infos.length - 5} more info messages`);
        }
        console.log('');
      }
    }

    console.log('');
    if (filteredDiagnostics.some((d: any) => d.severity === 'error' || d.severity === 'fatal')) {
      process.exit(1);
    }
  }
}
