/**
 * TestRFDB - Helper для создания RFDBServerBackend в тестах
 *
 * Автоматически создаёт временную БД для каждого теста и очищает после завершения
 */

import { RFDBServerBackend } from '@grafema/core';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';

let testCounter = 0;

export function createTestBackend() {
  const testId = `test-${Date.now()}-${testCounter++}`;
  const dbPath = join('/tmp', `.navi-test-${testId}`, 'graph.rfdb');
  const socketPath = `/tmp/rfdb-test-${testId}.sock`;

  const backend = new RFDBServerBackend({ dbPath, socketPath });

  // Добавляем метод cleanup для удаления временной БД
  backend.cleanup = async () => {
    await backend.close();
    try {
      const dir = join('/tmp', `.navi-test-${testId}`);
      rmSync(dir, { recursive: true, force: true });
      rmSync(socketPath, { force: true });
    } catch (err) {
      // Ignore cleanup errors
    }
  };

  return backend;
}

/**
 * Extended test backend with helper methods for test assertions
 */
export class TestBackend extends RFDBServerBackend {
  constructor() {
    const testId = `test-${Date.now()}-${testCounter++}`;
    const dbPath = join('/tmp', `.navi-test-${testId}`, 'graph.rfdb');
    const socketPath = `/tmp/rfdb-test-${testId}.sock`;
    super({ dbPath, socketPath });
    this._testDir = join('/tmp', `.navi-test-${testId}`);
    this._socketPath = socketPath;
  }

  async cleanup() {
    await this.close();
    try {
      rmSync(this._testDir, { recursive: true, force: true });
      rmSync(this._socketPath, { force: true });
    } catch (err) {
      // Ignore cleanup errors
    }
  }

  // Alias for compatibility
  async disconnect() {
    await this.cleanup();
  }
}
