#!/usr/bin/env node
/**
 * @grafema/cli - CLI for Grafema code analysis toolkit
 */

import { Command } from 'commander';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
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
import { explainCommand } from './commands/explain.js';

// Read version from package.json
const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));

const program = new Command();

program
  .name('grafema')
  .description('Grafema code analysis CLI')
  .version(pkg.version);

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
program.addCommand(explainCommand);

program.parse();
