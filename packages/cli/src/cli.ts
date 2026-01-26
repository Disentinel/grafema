#!/usr/bin/env node
/**
 * @grafema/cli - CLI for Grafema code analysis toolkit
 */

import { Command } from 'commander';
import { initCommand } from './commands/init.js';
import { analyzeCommand } from './commands/analyze.js';
import { overviewCommand } from './commands/overview.js';
import { queryCommand } from './commands/query.js';
import { typesCommand } from './commands/types.js';
import { lsCommand } from './commands/ls.js';
import { getCommand } from './commands/get.js';
import { traceCommand } from './commands/trace.js';
import { impactCommand } from './commands/impact.js';
import { exploreCommand } from './commands/explore.js';
import { statsCommand } from './commands/stats.js';
import { checkCommand } from './commands/check.js';
import { serverCommand } from './commands/server.js';
import { coverageCommand } from './commands/coverage.js';
import { doctorCommand } from './commands/doctor.js';
import { schemaCommand } from './commands/schema.js';

const program = new Command();

program
  .name('grafema')
  .description('Grafema code analysis CLI')
  .version('0.1.0-alpha.1');

// Commands in logical order
program.addCommand(initCommand);
program.addCommand(analyzeCommand);
program.addCommand(overviewCommand);
program.addCommand(queryCommand);
program.addCommand(typesCommand);
program.addCommand(lsCommand);
program.addCommand(getCommand);
program.addCommand(traceCommand);
program.addCommand(impactCommand);
program.addCommand(exploreCommand);
program.addCommand(statsCommand);  // Keep for backwards compat
program.addCommand(coverageCommand);
program.addCommand(checkCommand);
program.addCommand(serverCommand);
program.addCommand(doctorCommand);
program.addCommand(schemaCommand);

program.parse();
