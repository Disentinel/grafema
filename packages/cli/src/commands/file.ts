/**
 * File command - Show structured overview of a file's entities and relationships
 *
 * Purpose: Give a file-level summary with imports, exports, classes, functions,
 * and their key relationships (calls, extends, assigned-from).
 *
 * This fills the gap between:
 * - explain (lists ALL nodes flat, no relationships)
 * - context (shows ONE node's full neighborhood)
 *
 * @see REG-412
 */

import { Command } from 'commander';
import { resolve, join, relative, normalize } from 'path';
import { existsSync, realpathSync } from 'fs';
import { RFDBServerBackend, FileOverview } from '@grafema/core';
import type { FileOverviewResult, FunctionOverview } from '@grafema/core';
import { exitWithError } from '../utils/errorFormatter.js';
import { Spinner } from '../utils/spinner.js';

interface FileOptions {
  project: string;
  json?: boolean;
  edges?: boolean;
}

export const fileCommand = new Command('file')
  .description(
    'Show structured overview of a file: imports, exports, classes, functions with relationships'
  )
  .argument('<path>', 'File path to analyze')
  .option('-p, --project <path>', 'Project path', '.')
  .option('-j, --json', 'Output as JSON')
  .option('--no-edges', 'Skip edge resolution (faster, just list entities)')
  .addHelpText('after', `
Examples:
  grafema file src/app.ts              Show file overview with relationships
  grafema file src/app.ts --json       Output as JSON for scripting
  grafema file src/app.ts --no-edges   Fast mode: just list entities
  grafema file ./src/utils.js          Works with relative paths

Output shows:
  - Imports (module sources and specifiers)
  - Exports (named and default)
  - Classes with methods and their calls
  - Functions with their calls
  - Variables with assignment sources

Use 'grafema context <id>' to dive deeper into any specific entity.
`)
  .action(async (file: string, options: FileOptions) => {
    const projectPath = resolve(options.project);
    const grafemaDir = join(projectPath, '.grafema');
    const dbPath = join(grafemaDir, 'graph.rfdb');

    if (!existsSync(dbPath)) {
      exitWithError('No graph database found', [
        'Run: grafema init && grafema analyze',
      ]);
    }

    // Path resolution (same as explain command)
    let filePath = file;

    if (file.startsWith('./') || file.startsWith('../')) {
      filePath = normalize(file).replace(/^\.\//, '');
    } else if (resolve(file) === file) {
      filePath = relative(projectPath, file);
    }

    const resolvedPath = resolve(projectPath, filePath);
    if (!existsSync(resolvedPath)) {
      exitWithError(`File not found: ${file}`, [
        'Check the file path and try again',
      ]);
    }

    const absoluteFilePath = realpathSync(resolvedPath);
    const relativeFilePath = relative(projectPath, absoluteFilePath);

    const backend = new RFDBServerBackend({ dbPath });
    await backend.connect();

    const spinner = new Spinner('Loading file overview...');
    spinner.start();

    try {
      const overview = new FileOverview(backend);
      const result = await overview.getOverview(relativeFilePath, {
        includeEdges: options.edges !== false,
      });

      result.file = relativeFilePath;

      spinner.stop();

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      printFileOverview(result);
    } finally {
      spinner.stop();
      await backend.close();
    }
  });

function printFileOverview(result: FileOverviewResult): void {
  console.log(`Module: ${result.file}`);

  if (result.status === 'NOT_ANALYZED') {
    console.log('Status: NOT_ANALYZED');
    console.log('');
    console.log('This file has not been analyzed yet.');
    console.log('Run: grafema analyze');
    return;
  }

  if (result.imports.length > 0) {
    const importSources = result.imports.map(i => i.source);
    console.log(`Imports: ${importSources.join(', ')}`);
  }

  if (result.exports.length > 0) {
    const exportNames = result.exports.map(e =>
      e.isDefault ? `${e.name} (default)` : e.name
    );
    console.log(`Exports: ${exportNames.join(', ')}`);
  }

  if (result.classes.length > 0) {
    console.log('');
    console.log('Classes:');
    for (const cls of result.classes) {
      const extendsStr = cls.extends ? ` extends ${cls.extends}` : '';
      const lineStr = cls.line ? ` (line ${cls.line})` : '';
      console.log(`  ${cls.name}${extendsStr}${lineStr}`);

      for (const method of cls.methods) {
        printFunctionLine(method, '    ');
      }
    }
  }

  if (result.functions.length > 0) {
    console.log('');
    console.log('Functions:');
    for (const fn of result.functions) {
      printFunctionLine(fn, '  ');
    }
  }

  if (result.variables.length > 0) {
    console.log('');
    console.log('Variables:');
    for (const v of result.variables) {
      const lineStr = v.line ? `(line ${v.line})` : '';
      const assignStr = v.assignedFrom ? ` = ${v.assignedFrom}` : '';
      console.log(`  ${v.kind} ${v.name}${assignStr}  ${lineStr}`);
    }
  }
}

function printFunctionLine(fn: FunctionOverview, indent: string): void {
  const asyncStr = fn.async ? 'async ' : '';
  const paramsStr = fn.params ? `(${fn.params.join(', ')})` : '()';
  const lineStr = fn.line ? `(line ${fn.line})` : '';

  let callsStr = '';
  if (fn.calls.length > 0) {
    callsStr = `  -> ${fn.calls.join(', ')}`;
  }

  console.log(
    `${indent}${asyncStr}${fn.name}${paramsStr}${callsStr}  ${lineStr}`
  );
}
