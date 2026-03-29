/**
 * why command — "Why is it this way?"
 *
 * Query knowledge base for architectural decisions and facts about a symbol or module.
 *
 * Usage:
 *   grafema why auth-middleware       # Why was auth middleware designed this way?
 *   grafema why UserService           # Decisions about UserService
 */

import { Command } from 'commander';
import { resolve, join } from 'path';
import { existsSync } from 'fs';
import { KnowledgeBase } from '@grafema/util';
import type { KBDecision, KBFact } from '@grafema/util';
import { exitWithError } from '../utils/errorFormatter.js';
import { Spinner } from '../utils/spinner.js';

interface WhyCommandOptions {
  project: string;
  json?: boolean;
}

export const whyCommand = new Command('why')
  .description('Why is it this way? — query knowledge base decisions and facts')
  .argument('<query>', 'Search text (symbol name, module, or topic)')
  .option('-p, --project <path>', 'Project path', '.')
  .option('-j, --json', 'Output as JSON')
  .addHelpText('after', `
Examples:
  grafema why auth-middleware       Why was auth middleware designed this way?
  grafema why UserService           Decisions about UserService
  grafema why "error handling"      Facts about error handling approach
  grafema why dataflow --json       Output as JSON
`)
  .action(async (query: string, options: WhyCommandOptions) => {
    const projectPath = resolve(options.project);
    const knowledgeDir = join(projectPath, 'knowledge');

    if (!existsSync(knowledgeDir)) {
      exitWithError('No knowledge base found', [
        'Knowledge directory not found: ' + knowledgeDir,
        'Use `add_knowledge` MCP tool to capture architectural decisions',
      ]);
    }

    const spinner = new Spinner('Searching knowledge base...');
    spinner.start();

    try {
      const kb = new KnowledgeBase(knowledgeDir);
      await kb.load();

      // Search DECISION nodes matching query text
      const decisions = await kb.queryNodes({ type: 'DECISION', text: query }) as KBDecision[];

      // Search FACT nodes matching query text
      const facts = await kb.queryNodes({ type: 'FACT', text: query }) as KBFact[];

      spinner.stop();

      if (options.json) {
        console.log(JSON.stringify({
          query,
          decisions: decisions.map(d => ({
            id: d.id,
            status: d.status,
            content: d.content,
            applies_to: d.applies_to,
            relates_to: d.relates_to,
          })),
          facts: facts.map(f => ({
            id: f.id,
            confidence: f.confidence,
            content: f.content,
            relates_to: f.relates_to,
          })),
          total: decisions.length + facts.length,
        }, null, 2));
        return;
      }

      if (decisions.length === 0 && facts.length === 0) {
        console.log(`No knowledge found for: "${query}"`);
        console.log('');
        console.log('No decisions or facts recorded matching this query.');
        console.log('Use `add_knowledge` MCP tool to capture architectural decisions.');
        return;
      }

      // Display decisions
      if (decisions.length > 0) {
        console.log(`Decisions (${decisions.length}):`);
        console.log('');
        for (const d of decisions) {
          console.log(`  [${d.status?.toUpperCase() || 'ACTIVE'}] ${d.id}`);
          // Show first ~200 chars of content as summary
          const summary = d.content.length > 200
            ? d.content.substring(0, 200) + '...'
            : d.content;
          // Indent content lines
          for (const line of summary.split('\n')) {
            console.log(`    ${line}`);
          }
          if (d.applies_to && d.applies_to.length > 0) {
            console.log(`    Applies to: ${d.applies_to.join(', ')}`);
          }
          console.log('');
        }
      }

      // Display facts
      if (facts.length > 0) {
        console.log(`Facts (${facts.length}):`);
        console.log('');
        for (const f of facts) {
          const confidence = f.confidence ? ` [${f.confidence}]` : '';
          console.log(`  ${f.id}${confidence}`);
          const summary = f.content.length > 200
            ? f.content.substring(0, 200) + '...'
            : f.content;
          for (const line of summary.split('\n')) {
            console.log(`    ${line}`);
          }
          if (f.relates_to && f.relates_to.length > 0) {
            console.log(`    Relates to: ${f.relates_to.join(', ')}`);
          }
          console.log('');
        }
      }
    } finally {
      spinner.stop();
    }
  });
