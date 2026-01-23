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
  NodeCreationValidator,
  GraphFreshnessChecker,
  IncrementalReanalyzer
} from '@grafema/core';
import type { GuaranteeGraph } from '@grafema/core';
import type { GraphBackend } from '@grafema/types';

interface GuaranteeFile {
  guarantees: Array<{
    id: string;
    name: string;
    rule: string;
    severity?: 'error' | 'warning' | 'info';
    governs?: string[];
  }>;
}

// Available built-in validators
const BUILT_IN_VALIDATORS: Record<string, { name: string; description: string }> = {
  'node-creation': {
    name: 'NodeCreationValidator',
    description: 'Validates that all nodes are created through NodeFactory'
  }
};

export const checkCommand = new Command('check')
  .description('Check invariants/guarantees')
  .argument('[rule]', 'Specific rule ID to check (or "all" for all rules)')
  .option('-p, --project <path>', 'Project path', '.')
  .option('-f, --file <path>', 'Path to guarantees YAML file')
  .option('-g, --guarantee <name>', 'Run a built-in guarantee validator (e.g., node-creation)')
  .option('-j, --json', 'Output results as JSON')
  .option('-q, --quiet', 'Only output failures')
  .option('--list-guarantees', 'List available built-in guarantees')
  .option('--skip-reanalysis', 'Skip automatic reanalysis of stale modules')
  .option('--fail-on-stale', 'Exit with error if stale modules found (CI mode)')
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
        skipReanalysis?: boolean;
        failOnStale?: boolean;
      }
    ) => {
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

      // Run built-in guarantee validator
      if (options.guarantee) {
        const validatorInfo = BUILT_IN_VALIDATORS[options.guarantee];
        if (!validatorInfo) {
          console.error(`Error: Unknown guarantee "${options.guarantee}"`);
          console.error('');
          console.error('Available guarantees:');
          for (const key of Object.keys(BUILT_IN_VALIDATORS)) {
            console.error(`  - ${key}`);
          }
          process.exit(1);
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
        console.error(`Error: No database found at ${dbPath}`);
        console.error('Run "grafema analyze" first to create the database.');
        process.exit(1);
      }

      const backend = new RFDBServerBackend({ dbPath });
      await backend.connect();

      // Check graph freshness
      const freshnessChecker = new GraphFreshnessChecker();
      const freshness = await freshnessChecker.checkFreshness(backend);

      if (!freshness.isFresh) {
        if (options.failOnStale) {
          console.error(`Error: Graph is stale (${freshness.staleCount} module(s) changed)`);
          for (const stale of freshness.staleModules.slice(0, 5)) {
            console.error(`  - ${stale.file} (${stale.reason})`);
          }
          if (freshness.staleModules.length > 5) {
            console.error(`  ... and ${freshness.staleModules.length - 5} more`);
          }
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
          console.error(`Error: Guarantee "${rule}" not found.`);
          console.error('Available guarantees:');
          for (const g of guarantees) {
            console.error(`  - ${g.id}: ${g.name}`);
          }
          process.exit(1);
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
    console.error(`Error: No database found at ${dbPath}`);
    console.error('Run "grafema analyze" first to create the database.');
    process.exit(1);
  }

  const backend = new RFDBServerBackend({ dbPath });
  await backend.connect();

  // Check graph freshness
  const freshnessChecker = new GraphFreshnessChecker();
  const freshness = await freshnessChecker.checkFreshness(backend);

  if (!freshness.isFresh) {
    if (options.failOnStale) {
      console.error(`Error: Graph is stale (${freshness.staleCount} module(s) changed)`);
      for (const stale of freshness.staleModules.slice(0, 5)) {
        console.error(`  - ${stale.file} (${stale.reason})`);
      }
      if (freshness.staleModules.length > 5) {
        console.error(`  ... and ${freshness.staleModules.length - 5} more`);
      }
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
    let validator;
    let validatorName: string;

    switch (guaranteeName) {
      case 'node-creation':
        validator = new NodeCreationValidator();
        validatorName = 'NodeCreationValidator';
        break;
      default:
        console.error(`Unknown guarantee: ${guaranteeName}`);
        process.exit(1);
    }

    if (!options.quiet) {
      console.log(`Running ${validatorName}...`);
      console.log('');
    }

    const result = await validator.execute({
      graph: backend as unknown as GraphBackend,
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
          const location = issue.file ? `${issue.file}${issue.line ? `:${issue.line}` : ''}` : '';
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
