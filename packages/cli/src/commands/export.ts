/**
 * `grafema export` — emit a multi-format spec from the feature graph
 * (REG-1116, REG-1118).
 *
 * Modes shipped:
 *   --as openapi-3.1  → http:route features only
 *   --as docs-md      → all FEATURE categories (single + bulk)
 *
 * Phase 2 formats (mcp-schema, asyncapi, json-schema, ts-declarations,
 * mermaid) plug in by adding renderers to packages/util/src/exporters; the
 * CLI surface here doesn't change.
 */
import { Command } from 'commander';
import { resolve, join, dirname } from 'path';
import { existsSync, mkdirSync, writeFileSync } from 'fs';

import { RFDBServerBackend, RFDBClient, RENDERERS, type ExportBackendLike } from '@grafema/util';
import { exitWithError } from '../utils/errorFormatter.js';
import { runExport } from './exportAction.js';

interface ExportCliOptions {
  feature?: string;
  as?: string;
  output?: string;
  project: string;
}

const KNOWN_FORMATS = Object.keys(RENDERERS).sort().join(', ');

export const exportCommand = new Command('export')
  .description('Export FEATURE entries from the graph in a chosen format')
  .requiredOption('--feature <pattern>', "Feature glob (e.g. 'cli:*', 'http:*', \"cli:command:'analyze'\")")
  .requiredOption('--as <format>', `Output format (${KNOWN_FORMATS})`)
  .option('-o, --output <path>', 'Write output to <path> instead of stdout')
  .option('-p, --project <path>', 'Project path', '.')
  .addHelpText('after', `
Examples:
  grafema export --feature 'http:*' --as openapi-3.1 --output api.yaml
  grafema export --feature 'cli:*' --as docs-md
  grafema export --feature "cli:command:'analyze'" --as docs-md

Phase 1 supports two formats: openapi-3.1 (http:route only) and
docs-md (all categories). Other formats — mcp-schema, asyncapi,
json-schema, ts-declarations, mermaid — are tracked separately.
`)
  .action(async (options: ExportCliOptions) => {
    if (!options.feature || !options.as) {
      exitWithError('Both --feature and --as are required', [
        'See: grafema export --help',
      ]);
    }
    const projectPath = resolve(options.project);
    const grafemaDir = join(projectPath, '.grafema');
    const dbPath = join(grafemaDir, 'graph.rfdb');

    if (!existsSync(dbPath)) {
      exitWithError('No graph database found', ['Run: grafema analyze']);
    }

    // RFDBServerBackend negotiates protocol v3, which returns semantic edge
    // dst values that don't resolve via getNode(). Connect with a plain
    // RFDBClient (protocol v2) so edges preserve raw numeric ids end-to-end.
    // Still use RFDBServerBackend for its auto-start side effect.
    const server = new RFDBServerBackend({ dbPath, clientName: 'cli-bootstrap' });
    await server.connect();
    const socketPath = (server as unknown as { socketPath: string }).socketPath;
    const rawClient = new RFDBClient(socketPath, 'export');
    await rawClient.connect();

    try {
      await runExport(
        {
          feature: options.feature,
          as: options.as,
          output: options.output,
        },
        {
          backend: rawClient as unknown as ExportBackendLike,
          writeText: writeOutput,
          warn: (msg) => console.error(msg),
          fail: (msg, code) => {
            console.error(`✗ ${msg}`);
            process.exit(code);
          },
        },
      );
    } finally {
      rawClient.close();
      await server.close();
    }
  });

/** Default writer: stdout when path == null, otherwise file. */
function writeOutput(path: string | null, text: string): void {
  if (path === null) {
    process.stdout.write(text);
    return;
  }
  const dir = dirname(path);
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, text, 'utf8');
}
