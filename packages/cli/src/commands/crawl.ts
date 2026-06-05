/**
 * Crawl command — run ontological knowledge crawl on the codebase.
 *
 * Wraps scripts/crawl-v2.js which handles:
 *   - entity discovery and hypothesis generation via LLM
 *   - verification (Ollama or Haiku)
 *   - JSONL findings persistence
 *   - RFDB sync
 *
 * For --stats, reads local files directly without spawning the script.
 */

import { Command } from 'commander';
import { spawn } from 'child_process';
import { resolve, join } from 'path';
import { existsSync, readFileSync } from 'fs';

interface CrawlOptions {
  continuous?: boolean;
  entity?: string;
  sync?: boolean;
  verify?: string;
  model?: string;
  stats?: boolean;
}

interface BacklogEntry {
  name: string;
  status: string;
  type?: string;
  added?: string;
}

interface BacklogData {
  queue: BacklogEntry[];
  processed: BacklogEntry[];
  stats: Record<string, number>;
}

interface FindingRecord {
  verdict: string;
  entity?: string;
  hypothesis?: string;
  [key: string]: unknown;
}

function findCrawlScript(projectPath: string): string | null {
  const candidates = [
    join(projectPath, 'scripts', 'crawl-v2.js'),
    resolve(__dirname, '..', '..', '..', '..', 'scripts', 'crawl-v2.js'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function showStats(projectPath: string): void {
  const grafemaDir = join(projectPath, '.grafema');
  const backlogPath = join(grafemaDir, 'crawl-backlog.json');
  const jsonlPath = join(grafemaDir, 'crawl-findings.jsonl');

  console.log('Crawl Statistics');
  console.log('================\n');

  // Backlog stats
  if (existsSync(backlogPath)) {
    try {
      const backlog: BacklogData = JSON.parse(readFileSync(backlogPath, 'utf-8'));
      const inbox = backlog.queue.filter((e: BacklogEntry) => e.status === 'inbox').length;
      const processing = backlog.queue.filter((e: BacklogEntry) => e.status === 'processing').length;

      console.log('Backlog:');
      console.log(`  Queue:      ${backlog.queue.length} entities (${inbox} inbox, ${processing} processing)`);
      console.log(`  Processed:  ${backlog.processed.length} entities`);

      if (backlog.stats) {
        const s = backlog.stats;
        if (s.confirmed !== undefined) console.log(`  Confirmed:  ${s.confirmed}`);
        if (s.refuted !== undefined) console.log(`  Refuted:    ${s.refuted}`);
        if (s.unclear !== undefined) console.log(`  Unclear:    ${s.unclear}`);
      }
      console.log('');
    } catch {
      console.log('Backlog: unable to parse crawl-backlog.json\n');
    }
  } else {
    console.log('Backlog: not found (no crawl has been run yet)\n');
  }

  // JSONL findings stats
  if (existsSync(jsonlPath)) {
    try {
      const lines = readFileSync(jsonlPath, 'utf-8').split('\n').filter(Boolean);
      const verdicts: Record<string, number> = {};
      const entities = new Set<string>();

      for (const line of lines) {
        try {
          const obj: FindingRecord = JSON.parse(line);
          const v = obj.verdict || 'unknown';
          verdicts[v] = (verdicts[v] || 0) + 1;
          if (obj.entity) entities.add(obj.entity);
        } catch { /* skip malformed */ }
      }

      console.log('Findings (JSONL):');
      console.log(`  Total:      ${lines.length} records`);
      console.log(`  Entities:   ${entities.size} unique`);
      for (const [verdict, count] of Object.entries(verdicts).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${verdict}: ${count}`);
      }
    } catch {
      console.log('Findings: unable to parse crawl-findings.jsonl');
    }
  } else {
    console.log('Findings: not found (no crawl has been run yet)');
  }
}

export const crawlCommand = new Command('crawl')
  .description('Run ontological knowledge crawl on the codebase')
  .option('--continuous', 'Run continuously, processing all backlog entities')
  .option('--entity <name>', 'Crawl a specific entity')
  .option('--sync', 'Sync JSONL findings to RFDB knowledge database')
  .option('--verify <mode>', 'Verification mode: ollama (default) or haiku')
  .option('--model <model>', 'Generation model for Ollama')
  .option('--stats', 'Show crawl statistics only')
  .addHelpText('after', `
Examples:
  grafema crawl                    Process next entity from backlog
  grafema crawl --continuous       Run until backlog empty
  grafema crawl --entity "RFDB"    Crawl specific entity
  grafema crawl --verify haiku     Use Haiku API for verification
  grafema crawl --sync             Replay JSONL to RFDB
  grafema crawl --stats            Show crawl progress`)
  .action(async (options: CrawlOptions) => {
    const projectPath = resolve('.');

    // --stats: read files directly, no need to spawn
    if (options.stats) {
      showStats(projectPath);
      return;
    }

    const scriptPath = findCrawlScript(projectPath);
    if (!scriptPath) {
      console.error('Error: crawl-v2.js not found');
      console.error('Expected at: scripts/crawl-v2.js');
      process.exit(1);
    }

    // Build args for crawl-v2.js
    const args: string[] = [scriptPath];

    if (options.continuous) {
      args.push('--continuous');
    }
    if (options.entity) {
      args.push('--entity', options.entity);
    }
    if (options.sync) {
      args.push('--sync-rfdb');
    }
    if (options.verify) {
      args.push('--verify', options.verify);
    }
    if (options.model) {
      args.push('--model', options.model);
    }

    const child = spawn(process.execPath, args, {
      stdio: 'inherit',
      cwd: projectPath,
      env: {
        ...process.env,
        PROJECT_ROOT: projectPath,
      },
    });

    child.on('close', (code) => {
      process.exit(code ?? 0);
    });

    child.on('error', (err) => {
      console.error(`Failed to start crawl: ${err.message}`);
      process.exit(1);
    });
  });
