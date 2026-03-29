/**
 * who command — "Who uses this?"
 *
 * Find all callers and references to a symbol.
 *
 * Usage:
 *   grafema who authenticate          # Who calls authenticate()?
 *   grafema who UserService.findById  # Who calls this method?
 */

import { Command } from 'commander';
import { resolve, join, isAbsolute, relative } from 'path';
import { existsSync } from 'fs';
import { RFDBServerBackend } from '@grafema/util';
import { exitWithError } from '../utils/errorFormatter.js';
import { Spinner } from '../utils/spinner.js';

interface WhoCommandOptions {
  project: string;
  json?: boolean;
}

interface CallerInfo {
  file: string;
  line: number | undefined;
  callerName: string;
  resolved: boolean;
}

export const whoCommand = new Command('who')
  .description('Who uses this? — find all callers/references to a symbol')
  .argument('<symbol>', 'Function or method name')
  .option('-p, --project <path>', 'Project path', '.')
  .option('-j, --json', 'Output as JSON')
  .addHelpText('after', `
Examples:
  grafema who authenticate          Who calls authenticate()?
  grafema who UserService.findById  Who calls this method?
  grafema who handleRequest --json  Output as JSON
`)
  .action(async (symbol: string, options: WhoCommandOptions) => {
    const projectPath = resolve(options.project);
    const grafemaDir = join(projectPath, '.grafema');
    const dbPath = join(grafemaDir, 'graph.rfdb');

    if (!existsSync(dbPath)) {
      exitWithError('No graph database found', ['Run: grafema analyze']);
    }

    const backend = new RFDBServerBackend({ dbPath, clientName: 'cli' });
    await backend.connect();

    const spinner = new Spinner('Searching for callers...');
    spinner.start();

    try {
      const lowerSymbol = symbol.toLowerCase();
      // If symbol has a dot, extract the part after the last dot for method matching
      const dotIndex = symbol.lastIndexOf('.');
      const methodPart = dotIndex >= 0 ? symbol.substring(dotIndex + 1).toLowerCase() : null;

      // Strategy 1: Find CALL nodes that match the symbol name
      // (same approach as MCP handleFindCalls)
      const matchingCalls: CallerInfo[] = [];

      for await (const node of backend.queryNodes({ type: 'CALL' as any })) {
        const callName = (node.name || '').toLowerCase();

        // Match exact name or method part after last dot
        let isMatch = callName === lowerSymbol;
        if (!isMatch && methodPart) {
          const callMethodPart = callName.lastIndexOf('.') >= 0
            ? callName.substring(callName.lastIndexOf('.') + 1)
            : callName;
          isMatch = callMethodPart === methodPart;
        }
        if (!isMatch && !methodPart) {
          // Also match if the call name ends with the symbol (e.g., "obj.authenticate" matches "authenticate")
          const callMethodPart = callName.lastIndexOf('.') >= 0
            ? callName.substring(callName.lastIndexOf('.') + 1)
            : null;
          if (callMethodPart === lowerSymbol) isMatch = true;
        }

        if (!isMatch) continue;

        // Check resolution status via CALLS edges
        const edges = await backend.getOutgoingEdges(node.id, ['CALLS']);
        const resolved = edges.length > 0;

        // Extract caller name from semantic ID
        // Format: "file->SCOPE->TYPE->name" — parent scope is the caller
        const idParts = node.id.split('->');
        let callerName = '<anonymous>';
        // Walk up the scope chain to find a FUNCTION or METHOD parent
        for (let i = idParts.length - 3; i >= 1; i--) {
          if (idParts[i] === 'FUNCTION' || idParts[i] === 'METHOD') {
            callerName = idParts[i + 1] || callerName;
            break;
          }
        }

        const file = node.file || '';

        matchingCalls.push({
          file,
          line: node.line,
          callerName,
          resolved,
        });
      }

      // Strategy 2: Find the target function/method node and check incoming CALLS/READS_FROM edges
      const incomingCallers: CallerInfo[] = [];
      let funcNode = null;

      // Search for FUNCTION, METHOD, CLASS, or CONSTANT node matching the symbol
      for (const nodeType of ['FUNCTION', 'METHOD', 'CLASS', 'CONSTANT'] as const) {
        for await (const n of backend.queryNodes({ type: nodeType })) {
          const name = (n.name || '').toLowerCase();
          if (name === lowerSymbol || (methodPart && name === methodPart)) {
            funcNode = n;
            break;
          }
        }
        if (funcNode) break;
      }

      if (funcNode) {
        const incomingEdges = await backend.getIncomingEdges(funcNode.id, ['CALLS', 'READS_FROM', 'IMPORTS_FROM']);
        for (const edge of incomingEdges) {
          const srcNode = await backend.getNode(edge.src);
          if (!srcNode) continue;

          // Deduplicate — skip if we already found this call via Strategy 1
          if (matchingCalls.some(c => c.file === (srcNode.file || '') && c.line === srcNode.line)) {
            continue;
          }

          incomingCallers.push({
            file: srcNode.file || '',
            line: srcNode.line,
            callerName: srcNode.name || '<anonymous>',
            resolved: true,
          });
        }
      }

      // Strategy 3: Find IMPORT_BINDING nodes that import this symbol
      // (for classes/exports that are imported across files/repos)
      const importers: CallerInfo[] = [];
      for await (const n of backend.queryNodes({ type: 'IMPORT_BINDING' as any })) {
        const bindingName = (n.name || '').toLowerCase();
        if (bindingName !== lowerSymbol && !(methodPart && bindingName === methodPart)) continue;

        // Skip if already found via Strategy 1 or 2
        if (matchingCalls.some(c => c.file === (n.file || '') && c.line === n.line)) continue;
        if (incomingCallers.some(c => c.file === (n.file || '') && c.line === n.line)) continue;

        importers.push({
          file: n.file || '',
          line: n.line,
          callerName: `imports ${n.name || symbol}`,
          resolved: true,
        });
      }

      spinner.stop();

      // Merge results
      const allCallers = [...matchingCalls, ...incomingCallers, ...importers];

      if (options.json) {
        console.log(JSON.stringify({
          symbol,
          targetNode: funcNode ? { id: funcNode.id, type: funcNode.type, name: funcNode.name, file: funcNode.file } : null,
          callers: allCallers.map(c => ({
            file: c.file,
            line: c.line,
            caller: c.callerName,
            resolved: c.resolved,
          })),
          total: allCallers.length,
        }, null, 2));
        return;
      }

      if (allCallers.length === 0) {
        console.log(`${symbol} — no callers found`);
        console.log('');
        console.log('Hints:');
        console.log('  - Check the symbol name is correct');
        console.log('  - The function may be exported but unused in analyzed code');
        console.log('  - Use: grafema query "<name>" to verify the symbol exists');
        return;
      }

      console.log(`${symbol} — ${allCallers.length} caller${allCallers.length === 1 ? '' : 's'}`);
      console.log('');

      for (const caller of allCallers) {
        const relFile = isAbsolute(caller.file)
          ? relative(projectPath, caller.file)
          : caller.file;
        const location = caller.line ? `${relFile}:${caller.line}` : relFile;
        const status = caller.resolved ? '[resolved]' : '[unresolved]';
        const paddedLocation = location.padEnd(30);
        const paddedCaller = caller.callerName.padEnd(20);
        console.log(`  ${paddedLocation} ${paddedCaller} ${status}`);
      }
    } finally {
      spinner.stop();
      await backend.close();
    }
  });
