/**
 * tldr command — "What's in this file?"
 *
 * Human-first alias for `describe`. Shows notation DSL for a file.
 *
 * Usage:
 *   grafema tldr src/auth.ts          # File overview in DSL
 *   grafema tldr src/auth.ts --save   # Save as src/auth.ts.tldr
 */

import { Command } from 'commander';
import { resolve, join } from 'path';
import { existsSync, writeFileSync } from 'fs';
import {
  RFDBServerBackend,
  renderNotation,
  extractSubgraph,
} from '@grafema/util';
import type { DescribeOptions } from '@grafema/util';
import { exitWithError } from '../utils/errorFormatter.js';
import { Spinner } from '../utils/spinner.js';

interface TldrCommandOptions {
  project: string;
  save?: boolean;
  ext: string;
}

export const tldrCommand = new Command('tldr')
  .description("What's in this file? — compact DSL overview")
  .argument('<file>', 'File path to describe')
  .option('-p, --project <path>', 'Project path', '.')
  .option('-s, --save', 'Save output to <file>.<ext>')
  .option('--ext <ext>', 'File extension for --save', '.tldr')
  .addHelpText('after', `
Examples:
  grafema tldr src/auth.ts          File overview in DSL notation
  grafema tldr src/auth.ts --save   Save as src/auth.ts.tldr
  grafema tldr src/app.ts --save --ext .md   Save as src/app.ts.md
`)
  .action(async (file: string, options: TldrCommandOptions) => {
    const projectPath = resolve(options.project);
    const grafemaDir = join(projectPath, '.grafema');
    const dbPath = join(grafemaDir, 'graph.rfdb');

    if (!existsSync(dbPath)) {
      exitWithError('No graph database found', ['Run: grafema analyze']);
    }

    const backend = new RFDBServerBackend({ dbPath, clientName: 'cli' });
    await backend.connect();

    const spinner = new Spinner('Loading file overview...');
    spinner.start();

    try {
      // Find MODULE node for the file
      let node = null;
      for await (const n of backend.queryNodes({ file, type: 'MODULE' })) {
        node = n;
        break;
      }

      if (!node) {
        spinner.stop();
        exitWithError(`File not found in graph: "${file}"`, [
          'Check that the file was included in analysis',
          'Run: grafema analyze',
        ]);
        return;
      }

      // Extract subgraph at depth 2 (nested + fold)
      const subgraph = await extractSubgraph(backend, node.id, 2);

      // Render notation
      const describeOptions: DescribeOptions = {
        depth: 2,
        includeLocations: true,
      };
      const notation = renderNotation(subgraph, describeOptions);

      spinner.stop();

      const output = notation.trim()
        ? notation
        : `[${node.type}] ${node.name ?? node.id}\nNo relationships found.`;

      console.log(output);

      // Save to file if --save flag
      if (options.save) {
        const ext = options.ext.startsWith('.') ? options.ext : `.${options.ext}`;
        const outputPath = `${file}${ext}`;
        writeFileSync(outputPath, output + '\n', 'utf-8');
        console.log('');
        console.log(`Saved to ${outputPath}`);
      }
    } finally {
      spinner.stop();
      await backend.close();
    }
  });
