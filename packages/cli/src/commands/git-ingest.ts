/**
 * Git Ingest command - ingest git history into knowledge layer
 */

import { Command } from 'commander';
import { resolve, join } from 'path';
import { GitIngest } from '@grafema/util';

export const gitIngestCommand = new Command('git-ingest')
  .description('Ingest git history into the knowledge layer')
  .argument('[path]', 'Repository path', '.')
  .option('--full', 'Full re-ingest (rebuilds derived/)')
  .option('--since <date>', 'Ingest from date (ISO format)')
  .option('--branch <branch>', 'Ingest specific branch')
  .addHelpText('after', `
Examples:
  grafema git-ingest                    Incremental ingest from last cursor
  grafema git-ingest --full             Full re-ingest of all history
  grafema git-ingest --full ./my-repo   Full ingest of specific repo
  grafema git-ingest --branch develop   Ingest specific branch
  grafema git-ingest --since 2025-01-01 Ingest from specific date
`)
  .action(async (path: string, options: { full?: boolean; since?: string; branch?: string }) => {
    const repoPath = resolve(path);
    const knowledgeDir = join(repoPath, '.grafema', 'knowledge');

    const ingest = new GitIngest(knowledgeDir);

    console.log(`Ingesting git history from ${repoPath}...`);

    try {
      let result;
      if (options.full || options.since) {
        result = await ingest.ingestFull(repoPath, options.branch, options.since);
      } else {
        result = await ingest.ingestIncremental(repoPath, options.branch);
      }

      console.log('Git ingest complete:');
      console.log(`  Commits: ${result.commits}`);
      console.log(`  Authors: ${result.authors}`);
      console.log(`  Files changed: ${result.filesChanged}`);
      console.log(`\nData written to ${knowledgeDir}/derived/`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Error: ${message}`);
      process.exit(1);
    }
  });
