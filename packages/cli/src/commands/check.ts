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
import { RFDBServerBackend, GuaranteeManager, NodeCreationValidator } from '@grafema/core';
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
  .action(
    async (
      rule: string | undefined,
      options: { project: string; file?: string; guarantee?: string; json?: boolean; quiet?: boolean; listGuarantees?: boolean }
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

        await runBuiltInValidator(options.guarantee, options.project, options);
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
                const location = v.file ? `${v.file}${v.line ? `:${v.line}` : ''}` : v.nodeId;
                console.log(`    - ${location}: ${v.name || v.type}`);
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
  options: { json?: boolean; quiet?: boolean }
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
