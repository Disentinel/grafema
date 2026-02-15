/**
 * Explain command - Show what nodes exist in a file
 *
 * Purpose: Help users discover what nodes exist in the graph for a file,
 * displaying semantic IDs so users can query them.
 *
 * Use cases:
 * - User can't find a variable they expect to be in the graph
 * - User wants to understand what's been analyzed for a file
 * - User needs semantic IDs to construct queries
 *
 * @see _tasks/REG-177/006-don-revised-plan.md
 */

import { Command } from 'commander';
import { resolve, join, relative, normalize } from 'path';
import { existsSync, realpathSync } from 'fs';
import { toRelativeDisplay } from '../utils/pathUtils.js';
import { RFDBServerBackend, FileExplainer, type EnhancedNode } from '@grafema/core';
import { exitWithError } from '../utils/errorFormatter.js';

interface ExplainOptions {
  project: string;
  json?: boolean;
}

export const explainCommand = new Command('explain')
  .description('Show what nodes exist in a file')
  .argument('<file>', 'File path to explain')
  .option('-p, --project <path>', 'Project path', '.')
  .option('-j, --json', 'Output as JSON')
  .addHelpText('after', `
Examples:
  grafema explain src/app.ts           Show all nodes in src/app.ts
  grafema explain src/app.ts --json    Output as JSON for scripting
  grafema explain ./src/utils.js       Works with relative paths

This command helps you:
  1. Discover what nodes exist in the graph for a file
  2. Find semantic IDs to use in queries
  3. Understand scope context (try/catch, conditionals, etc.)

If a file shows NOT_ANALYZED:
  - Run: grafema analyze
  - Check if file is excluded in config
`)
  .action(async (file: string, options: ExplainOptions) => {
    const projectPath = resolve(options.project);
    const grafemaDir = join(projectPath, '.grafema');
    const dbPath = join(grafemaDir, 'graph.rfdb');

    // Check database exists
    if (!existsSync(dbPath)) {
      exitWithError('No graph database found', [
        'Run: grafema init && grafema analyze',
      ]);
    }

    // Normalize and resolve file path
    let filePath = file;

    // Handle relative paths - convert to relative from project root
    if (file.startsWith('./') || file.startsWith('../')) {
      filePath = normalize(file).replace(/^\.\//, '');
    } else if (resolve(file) === file) {
      // Absolute path - convert to relative
      filePath = relative(projectPath, file);
    }

    // Resolve to absolute path for graph lookup
    const resolvedPath = resolve(projectPath, filePath);
    if (!existsSync(resolvedPath)) {
      exitWithError(`File not found: ${file}`, [
        'Check the file path and try again',
      ]);
    }

    // Use realpath to match how graph stores paths (handles symlinks like /tmp -> /private/tmp on macOS)
    const absoluteFilePath = realpathSync(resolvedPath);

    // Keep relative path for display
    const relativeFilePath = relative(projectPath, absoluteFilePath);

    const backend = new RFDBServerBackend({ dbPath });
    await backend.connect();

    try {
      const explainer = new FileExplainer(backend);
      // Query with relative path since MODULE nodes store relative file paths
      const result = await explainer.explain(relativeFilePath);

      // Override file in result for display purposes (show relative path)
      result.file = relativeFilePath;

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      // Human-readable output
      console.log(`File: ${result.file}`);
      console.log(`Status: ${result.status}`);
      console.log('');

      if (result.status === 'NOT_ANALYZED') {
        console.log('This file has not been analyzed yet.');
        console.log('');
        console.log('To analyze:');
        console.log('  grafema analyze');
        return;
      }

      console.log(`Nodes in graph: ${result.totalCount}`);
      console.log('');

      // Group nodes by type for display
      const nodesByType = groupNodesByType(result.nodes);

      for (const [type, nodes] of Object.entries(nodesByType)) {
        for (const node of nodes) {
          displayNode(node, type, projectPath);
          console.log('');
        }
      }

      // Show summary by type
      console.log('Summary:');
      for (const [type, count] of Object.entries(result.byType).sort()) {
        console.log(`  ${type}: ${count}`);
      }

      console.log('');
      console.log('To query a specific node by ID:');
      console.log('  grafema query --raw \'attr(X, "id", "<semantic-id>")\'');
    } finally {
      await backend.close();
    }
  });

/**
 * Group nodes by type for organized display
 */
function groupNodesByType(nodes: EnhancedNode[]): Record<string, EnhancedNode[]> {
  const grouped: Record<string, EnhancedNode[]> = {};

  for (const node of nodes) {
    const type = node.type || 'UNKNOWN';
    if (!grouped[type]) {
      grouped[type] = [];
    }
    grouped[type].push(node);
  }

  return grouped;
}

/**
 * Display a single node in human-readable format
 */
function displayNode(node: EnhancedNode, type: string, projectPath: string): void {
  // Line 1: [TYPE] name (context)
  const contextSuffix = node.context ? ` (${node.context})` : '';
  console.log(`[${type}] ${node.name || '<anonymous>'}${contextSuffix}`);

  // Line 2: ID (semantic ID for querying)
  console.log(`  ID: ${node.id}`);

  // Line 3: Location
  if (node.file) {
    const relPath = toRelativeDisplay(node.file, projectPath);
    const loc = node.line ? `${relPath}:${node.line}` : relPath;
    console.log(`  Location: ${loc}`);
  }
}
