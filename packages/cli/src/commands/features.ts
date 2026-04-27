/**
 * `grafema features` — surface FEATURE-level cross-modality insights.
 *
 * Currently exposes one mode:
 *   --duplicates   List clusters of FEATUREs whose entry-points share an
 *                  identical BEHAVIOR (same forward-slice hash).
 *
 * Other modes (--by-effect, --by-domain, …) are anticipated but not in scope
 * for REG-1119.
 */

import { Command } from 'commander';
import { resolve, join } from 'path';
import { existsSync } from 'fs';
import { RFDBServerBackend } from '@grafema/util';
import { exitWithError } from '../utils/errorFormatter.js';
import {
  findSharedBehaviorClusters,
  formatSharedBehaviorClusters,
  type FeaturesBackendLike,
} from './featuresAction.js';

interface FeaturesCliOptions {
  project: string;
  json?: boolean;
  duplicates?: boolean;
  minClusterSize?: string;
  limit?: string;
}

export const featuresCommand = new Command('features')
  .description('List FEATURE-level cross-modality insights (e.g. duplicate behaviors)')
  .option('-p, --project <path>', 'Project path', '.')
  .option('-j, --json', 'Output as JSON')
  .option('-d, --duplicates', 'List clusters of FEATUREs that share a BEHAVIOR')
  .option('--min-cluster-size <n>', 'Minimum features per cluster (default: 2)', '2')
  .option('--limit <n>', 'Maximum clusters to return (default: 100)', '100')
  .addHelpText('after', `
Examples:
  grafema features --duplicates             List FEATUREs with shared behaviors
  grafema features --duplicates --json      Same, machine-readable JSON
  grafema features -d --min-cluster-size 3  Only clusters with >=3 features
`)
  .action(async (options: FeaturesCliOptions) => {
    if (!options.duplicates) {
      exitWithError('No subcommand selected', [
        'Try: grafema features --duplicates',
        'See: grafema features --help',
      ]);
    }

    const projectPath = resolve(options.project);
    const grafemaDir = join(projectPath, '.grafema');
    const dbPath = join(grafemaDir, 'graph.rfdb');

    if (!existsSync(dbPath)) {
      exitWithError('No graph database found', ['Run: grafema analyze']);
    }

    const minClusterSize = parsePositiveInt(options.minClusterSize, 2);
    const limit = parsePositiveInt(options.limit, 100);

    const backend = new RFDBServerBackend({ dbPath, clientName: 'cli' });
    await backend.connect();

    try {
      // RFDBServerBackend matches FeaturesBackendLike at runtime.
      const clusters = await findSharedBehaviorClusters(
        backend as unknown as FeaturesBackendLike,
        { minClusterSize, limit },
      );

      if (options.json) {
        console.log(JSON.stringify(clusters, null, 2));
      } else {
        console.log(formatSharedBehaviorClusters(clusters));
      }
    } finally {
      await backend.close();
    }
  });

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}
