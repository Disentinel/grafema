/**
 * ASTWorker - worker thread script for parallel AST parsing.
 *
 * Receives: { filePath, relativeFile, moduleId, moduleName }
 * Returns: { collections } - extracted AST data for GraphBuilder
 *
 * REG-579: Rewritten to use shared extractModuleCollections(),
 * eliminating 568 lines of duplicate extraction logic. Both sequential
 * and parallel paths now produce identical output.
 */

import { parentPort } from 'worker_threads';
import { extractModuleCollections } from '../plugins/analysis/ast/extractModuleCollections.js';

interface ParseMessage {
  type: 'parse';
  taskId: number;
  filePath: string;
  relativeFile: string;
  moduleId: string;
  moduleName: string;
}

interface ExitMessage {
  type: 'exit';
}

type WorkerMessage = ParseMessage | ExitMessage;

if (parentPort) {
  parentPort.on('message', (msg: WorkerMessage) => {
    if (msg.type === 'parse') {
      try {
        const collections = extractModuleCollections(
          msg.filePath, msg.relativeFile, msg.moduleId, msg.moduleName
        );
        parentPort!.postMessage({ type: 'result', taskId: msg.taskId, collections });
      } catch (error) {
        parentPort!.postMessage({
          type: 'error',
          taskId: msg.taskId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } else if (msg.type === 'exit') {
      process.exit(0);
    }
  });

  parentPort.postMessage({ type: 'ready' });
}
