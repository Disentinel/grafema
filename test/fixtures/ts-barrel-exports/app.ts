/**
 * Consumer - imports through barrel file
 */

import { AuthenticatedRequest, CrontabConfig, UserRole } from './types';
import { AppConfig, DatabaseConfig } from './types';

function handleRequest(req: AuthenticatedRequest): string {
  return req.userId;
}

function loadConfig(): AppConfig {
  return { port: 3000, host: 'localhost' };
}

function createCrontab(config: CrontabConfig): void {
  console.log(config.intervalMs);
}

export { handleRequest, loadConfig, createCrontab };
